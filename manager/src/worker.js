import {connectRoute,deviceAuth,deviceRoute} from './connect.js';
import cfg from '../config.json';
import {selectedProfile,saveSelection,runModel,recordModel,runSupportsJobs,deploymentModels,publicCatalog,profileConfig} from './models.js';
import {CONTEXT_LENGTHS} from '../../shared/context.mjs';
import {findRunNotebook,findInstallationNotebook,matchesRun,ownNotebookRefs} from '../../shared/notebooks.mjs';
import runner from '../notebook/runner.py';
import mediaRunner from '../notebook/media.py';
import {BUILD, API_ROOT, kaggleRpc, listOwnKernels, redact, normalizeKernelRef, settingsFromSource} from './kaggle.js';

const TERMINAL = new Set(['COMPLETE', 'ERROR', 'CANCEL_ACKNOWLEDGED','CANCELLED','CANCELED']);
const STATES = ['QUEUED','RUNNING','COMPLETE','ERROR','CANCEL_REQUESTED','CANCEL_ACKNOWLEDGED','NEW_SCRIPT'];
const sec = () => Date.now() / 1000;
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'}});
class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new AppError(status, message); };
export const normalizeState = v => typeof v === 'number' ? (STATES[v] || 'UNKNOWN') : String(v || 'UNKNOWN').toUpperCase();
export function duration(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?s$/.test(v)) return parseFloat(v);
  if (v && typeof v === 'object' && v.seconds !== undefined) return Number(v.seconds);
  return null;
}
export function safeUrl(value, config = cfg) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      u.pathname === '/' && !u.search && !u.hash &&
      (u.hostname.endsWith('.trycloudflare.com') || value.replace(/\/$/, '') === config.model_url.replace(/\/$/, ''));
  } catch { return false; }
}
async function hash(value) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d), x => x.toString(16).padStart(2, '0')).join('');
}
async function auth(req, token) {
  if (!token || token.length < 24) fail(503, '管理端尚未配置访问密钥');
  if (await hash(req.headers.get('authorization') || '') !== await hash('Bearer ' + token)) fail(401, '访问密钥不正确');
}
async function contextSize(env,model){try{const row=await env.DB.prepare("SELECT value FROM studio_options WHERE name=?").bind(cfg.model_profiles?.length?"context_size:"+model.id:"context_size").first();if(CONTEXT_LENGTHS.includes(Number(row?.value)))return Number(row.value)}catch{}return model?.config?.context_size||cfg.context_size}
async function probeEndpoint(env,r){
 if(!r?.active||r.stop||r.service!=='ready'||!r.url||!r.heartbeat||sec()-r.heartbeat>65)return {checked:false,reachable:null};
 try{const target=cfg.tunnel_mode==='vpc'?'http://llama':r.url;const fetcher=cfg.tunnel_mode==='vpc'?env.MODEL_VPC.fetch.bind(env.MODEL_VPC):fetch;
  const response=await fetcher(target+'/v1/models',{headers:{authorization:'Bearer '+env.MODEL_API_KEY},redirect:'manual',signal:AbortSignal.timeout(5000)});
  let data=null;try{data=await response.json()}catch{}const reachable=response.ok&&Array.isArray(data?.data)&&data.data.length>0;
  return {checked:true,reachable,http_status:response.status,runtime_build:data?.studio_runtime?.build||null,last_error_code:data?.studio_runtime?.last_error_code||null};
 }catch{return {checked:true,reachable:false,error_code:'MODEL_TUNNEL_UNREACHABLE'}}
}
async function latest(env) { return env.DB.prepare('SELECT * FROM runs ORDER BY requested DESC LIMIT 1').first(); }
async function storedRef(env,r){try{return (await env.DB.prepare('SELECT kernel_ref FROM studio_run_refs WHERE run_id=?').bind(r.id).first())?.kernel_ref||cfg.kernel_ref}catch{return cfg.kernel_ref}}
async function rememberRef(env,id,ref){await env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_run_refs(run_id TEXT PRIMARY KEY,kernel_ref TEXT NOT NULL)').run();await env.DB.prepare('INSERT INTO studio_run_refs(run_id,kernel_ref) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET kernel_ref=excluded.kernel_ref').bind(id,ref).run()}
async function matchesRunForSubmission(notebook,run){return matchesRun(notebook,run,{configuredRef:cfg.kernel_ref,managerUrl:cfg.manager_url})}
async function recoverNotebook(env,r){const found=await findRunNotebook((op,b)=>kaggleRpc(env,op,b),{configuredRef:cfg.kernel_ref,managerUrl:cfg.manager_url,run:r});await rememberRef(env,r.id,found.ref);return found}
async function update(env, id, fields) {
  const keys = Object.keys(fields);
  await env.DB.prepare('UPDATE runs SET ' + keys.map(k => k + '=?').join(',') + ' WHERE id=?')
    .bind(...keys.map(k => fields[k]), id).run();
}
function publicRun(r) {
  if (!r) return null;
  const {agent_hash, ...out} = r;
  out.endpoint_reachable = r.note==='MODEL_TUNNEL_UNREACHABLE'?false:null;
  out.stale = !r.heartbeat || sec() - r.heartbeat > 65;
  // A late status check observes termination; it does not prove GPU ran until the check time.
  out.ended_estimate_only = !!(r.ended && r.heartbeat && r.ended-r.heartbeat>65);
  out.remaining_seconds_estimate = r.started && !r.ended ? Math.max(0, cfg.max_minutes * 60 - sec() + r.started) : null;
  return out;
}
function validateConfig() {
  if (!/^https:\/\//.test(cfg.manager_url) || cfg.manager_url.includes('example.com') || cfg.kernel_ref.includes('YOUR_'))
    fail(400, '请先修改 config.json 中的域名和 Kaggle 用户名');
  if (!/^[\w-]+\/[\w-]+$/.test(cfg.kernel_ref)) fail(400, 'Kaggle 项目路径格式错误');
  if (!Number.isInteger(cfg.max_minutes) || cfg.max_minutes < 1 || cfg.max_minutes > 710) fail(400, '运行时长应为 1–710 分钟');
  if (!['quick','named','vpc'].includes(cfg.tunnel_mode)) fail(400, '隧道模式错误');
}
export function notebookPayload(config, settings, target=null) {
  // JSON is parsed in Python rather than interpolated as executable source.
  const text = 'import json\nSETTINGS = json.loads(' + JSON.stringify(JSON.stringify(settings)) + ')\n' + runner.replace('# __STUDIO_MEDIA_RUNTIME__',mediaRunner);
  const metadata=target?.notebook?.metadata,identity=Number(metadata?.id);
  return {...(Number.isSafeInteger(identity)&&identity>0?{id:identity}:{}),slug: target?.ref||config.kernel_ref, newTitle: metadata?.title||config.kernel_title, text, language: 'python', kernelType: 'script',
    isPrivate: true, enableGpu: true, enableInternet: true, enableTpu: false,
    datasetDataSources: config.dataset_sources, kernelDataSources: [], competitionDataSources: [],
    modelDataSources: [], machineShape: config.accelerator, sessionTimeoutSeconds: 43200};
}
async function route(req, env) {
  const u = new URL(req.url), path = u.pathname;
  if (path === '/healthz') return json({ok: true, build: BUILD, installation_id: env.STUDIO_INSTALLATION_ID || null});
  if (path.startsWith('/connect/')) return await connectRoute(req,env,cfg);
  if (path.startsWith('/agent/')) {
    if (req.method !== 'POST') fail(405, '仅支持 POST');
    const r = await latest(env);
    if (!r || path !== '/agent/' + r.id) fail(409, '运行已过期');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (await hash(token) !== r.agent_hash) fail(401, '运行端认证失败');
    if (!r.active) return json({stop: true});
    const b = await req.json();
    if (!['starting','loading','ready','stopped','error'].includes(b.state)) fail(400, '运行状态错误');
    const url = String(b.url || '').replace(/\/$/, '');
    if (url && !(cfg.tunnel_mode === 'vpc' && url === 'https://studio-vpc.invalid') && !safeUrl(url)) fail(400, '不允许的模型地址');
    let reachable;
    if (cfg.tunnel_mode === 'vpc' && (b.probe || b.state === 'ready' && r.service !== 'ready')) {
      try { const probe = await env.MODEL_VPC.fetch('http://llama/v1/models', {headers: {authorization: 'Bearer ' + env.MODEL_API_KEY}, redirect:'manual', signal:AbortSignal.timeout(5000)});
        const data = probe.ok ? await probe.json() : null; reachable = Array.isArray(data?.data);
      } catch { reachable = false; }
      if (b.state === 'ready' && !reachable) fail(503, 'Private model tunnel is not reachable.');
    }
    const phaseNote=['weights','vision'].includes(b.asset)&&Number.isInteger(b.download_percent)&&b.download_percent>=0&&b.download_percent<=100?'MODEL_DOWNLOAD:'+b.asset+':'+b.download_percent:b.state==='loading'?'MODEL_LOADING':b.state==='ready'?'':undefined;
    const now = sec(), started = r.started || now;
    await update(env, r.id, {started, heartbeat: now, service: b.state,
      ...(phaseNote===undefined?{}:{note:phaseNote}),
      url: b.state === 'ready' ? (cfg.tunnel_mode === 'vpc' ? 'https://studio-vpc.invalid' : (url || r.url)) : ''});
    // Secrets stay out of notebook source and panel responses; only this run can fetch them.
    return json({...(reachable === undefined ? {} : {model_reachable: reachable}), stop: !!r.stop || now - started >= cfg.max_minutes * 60,
      ...(b.bootstrap ? {model_api_key: env.MODEL_API_KEY, tunnel_token: ['named','vpc'].includes(cfg.tunnel_mode) ? env.CF_TUNNEL_TOKEN : ''} : {})});
  }
  if (path.startsWith('/v1/')) {
    if (!await deviceAuth(req,env,'model')) await auth(req, env.MODEL_API_KEY);
    if (!['GET','POST'].includes(req.method)) fail(405, '请求方法不支持');
    if (!['models','chat/completions','completions','responses','messages','images/generations'].includes(path.slice(4)) && !/^\/v1\/(?:media|chat)\/jobs(?:\/[a-f0-9]{32}(?:\/(?:file|cancel))?)?$/.test(path)) fail(404, '接口不存在');
    const r = await latest(env);
    if (!r || !r.active || r.stop || r.service !== 'ready' || !r.url || !r.heartbeat || sec() - r.heartbeat > 65)
      fail(503, '模型未就绪、已请求停止或运行端失联');
    let body;
    if (req.method === 'POST') {
      const reader=req.body?.getReader();let size=0,chunks=[];if(!reader)fail(400,'Expected JSON content.');while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();fail(413,'Request exceeds 8 MB. Reduce attached images or start a new conversation.');}chunks.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}const raw=new TextDecoder().decode(bytes);
      let b; try { b = JSON.parse(raw); } catch { fail(400, '需要 JSON 请求'); }
      if (cfg.tunnel_mode === 'quick' && b.stream) fail(400, '临时隧道不支持 SSE，请关闭 stream 或使用固定隧道');
      body = raw;
    }
    let upstream;
    try { upstream = await (cfg.tunnel_mode === 'vpc' ? env.MODEL_VPC.fetch.bind(env.MODEL_VPC) : fetch)((cfg.tunnel_mode === 'vpc' ? 'http://llama' : r.url) + path + (/^\/v1\/chat\/jobs\/[a-f0-9]{32}$/.test(path)?'?offset='+Math.max(0,Number(u.searchParams.get('offset'))||0):''), {method: req.method,
      headers: {authorization: 'Bearer ' + env.MODEL_API_KEY, 'content-type': 'application/json'}, body, redirect: 'manual'}); }
    catch {await update(env,r.id,{note:'MODEL_TUNNEL_UNREACHABLE'});fail(502, 'The model endpoint is unreachable. Check Compute and the Kaggle runtime before sending again.');}
    // Pass the stream through without accumulating model output in Worker memory.
    return new Response(upstream.body, {status: upstream.status, headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store', 'x-accel-buffering': 'no'}});
  }
  if (path.startsWith('/api/')) {
    const device=await deviceAuth(req,env,'manager');
    if(!device) await auth(req, env.ADMIN_TOKEN);
    const deviceResponse=await deviceRoute(req,env,device);if(deviceResponse)return deviceResponse;
    if (env.ADMIN_TOKEN === env.MODEL_API_KEY) fail(503, '管理密钥和模型密钥必须不同');
    if (path === '/api/models' && req.method === 'GET') {
      const [userName, kernelSlug] = cfg.kernel_ref.split('/');
      const run=await latest(env);let current;let actualRef=run?await storedRef(env,run):cfg.kernel_ref;
      if(Array.isArray(cfg.model_profiles)&&cfg.model_profiles.length){const endpoint=await probeEndpoint(env,run),model=await selectedProfile(env,cfg),active=endpoint.reachable!==false&&run?.active&&!run.stop&&run.service==='ready'&&!publicRun(run).stale?await runModel(env,run,cfg):null;
       return json({build:BUILD,source:'manager_deployment',read_only:true,notebook:{ref:actualRef,title:cfg.kernel_title,version:run?.version||null},models:publicCatalog(cfg,model.id,active),note:''});}

      try{const [owner,slug]=actualRef.split('/');current=await kaggleRpc(env,'GetKernel',{userName:owner,kernelSlug:slug})}catch(e){
       if(run&&[403,404].includes(e.http_status)){const recovered=await recoverNotebook(env,run);current=recovered.notebook;actualRef=recovered.ref;}else throw e;
      }
      const metadata = current.metadata || {};
      const ref = metadata.ref ? normalizeKernelRef(metadata.ref) : normalizeKernelRef(cfg.kernel_ref);
      if (!ref || ref !== normalizeKernelRef(actualRef)) fail(502, 'Kaggle returned an unexpected notebook reference.');
      const settings = settingsFromSource(current.blob?.source);
      const matching = settings && normalizeKernelRef(settings.kernel_ref) === normalizeKernelRef(cfg.kernel_ref);
      const alias = matching && typeof settings.model_alias === 'string' ? settings.model_alias : '';
      const modelId = alias && alias.length <= 256 && !/[\u0000-\u001f\u007f]/.test(alias) ? alias : '';
      const version = Number(metadata.currentVersionNumber);
      // Never return notebook source, SETTINGS, runtime tokens or arbitrary metadata.
      return json({build: BUILD, read_only: true, source: 'kaggle',
        notebook: {ref, title: typeof metadata.title === 'string' ? metadata.title.slice(0,160) : kernelSlug,
          version: Number.isSafeInteger(version) && version > 0 ? version : null},
        models: modelId ? [{id: modelId, type: 'chat', source: 'kaggle_notebook', notebook_ref: ref,
          status: 'configured'}] : [],
        model_assets: Array.isArray(metadata.modelDataSources) ? metadata.modelDataSources
          .filter(x => typeof x === 'string' && /^[\w.-]+\/[\w.-]+\/[\w.-]+\/[\w.-]+(?:\/\d+)?$/.test(x)).slice(0,30) : [],
        note: modelId ? 'Model read from the managed Kaggle notebook. Query the model API to confirm it is serving requests.' :
          'No supported model declaration was found in this notebook. Attached model assets are not inference endpoints.'});
    }
    if (path === '/api/diagnostics' && req.method === 'GET') {
      const report = {build: BUILD, read_only: true, api_root: API_ROOT, kernel_ref: cfg.kernel_ref,
        secrets: Object.fromEntries(['ADMIN_TOKEN','MODEL_API_KEY','KAGGLE_API_TOKEN','CF_TUNNEL_TOKEN']
          .map(k => [k, !!env[k]])), checks: []};
      try {
        const own = await listOwnKernels(env);
        report.checks.push({check: 'ListKernels', ok: true, refs: own.map(k => k.ref).filter(v => typeof v === 'string').slice(0,20),
          note: 'Read-only request succeeded. Listing is limited to the first page; this does not prove GPU availability.'});
      } catch(e) { report.checks.push({check: 'ListKernels', ok: false, error: redact(e.message, env), kind: e.kind || 'unknown'}); }
      const r = await latest(env);
      const [userName, kernelSlug] = (r?await storedRef(env,r):cfg.kernel_ref).split('/');
      try {
        const result = await kaggleRpc(env, 'GetKernelSessionStatus', {userName, kernelSlug,
          ...(r?.version ? {versionLabel: 'v'+r.version} : {})});
        report.checks.push({check: 'GetKernelSessionStatus', ok: true, state: normalizeState(result.status),
          note: 'Status query only. No run was submitted or stopped and no local lock was cleared.'});
      } catch(e) { report.checks.push({check: 'GetKernelSessionStatus', ok: false, error: redact(e.message, env), kind: e.kind || 'unknown'}); }
      const endpoint=await probeEndpoint(env,r);if(endpoint.checked)report.checks.push({check:'ModelEndpoint',ok:endpoint.reachable,...endpoint});
      return json(report);
    }
    if (path === '/api/status' && req.method === 'GET') {
      const history = await env.DB.prepare('SELECT * FROM runs ORDER BY requested DESC LIMIT 8').all();
      const selected=await selectedProfile(env,cfg),active=history.results[0]?await runModel(env,history.results[0],cfg):null,effective=profileConfig(cfg,selected);
      const endpoint=await probeEndpoint(env,history.results[0]);
      if(endpoint.reachable===true&&history.results[0]?.note==='MODEL_TUNNEL_UNREACHABLE'){await update(env,history.results[0].id,{note:''});history.results[0].note=''}
      return json({build:BUILD,endpoint,requires_runtime_restart:!!(history.results[0]?.active&&effective.model_kind!=='chat'&&endpoint.reachable===true&&endpoint.runtime_build!==BUILD),capabilities:{manual_run_confirmation:true,notebook_ref_recovery:true,notebook_reuse:true,context_configuration:true,background_jobs:await runSupportsJobs(env,history.results[0]),multi_model:Array.isArray(cfg.model_profiles)&&cfg.model_profiles.length>0},selected_model:selected?.id,active_model:active,models:publicCatalog(cfg,selected?.id,endpoint.reachable!==false&&history.results[0]?.active&&history.results[0]?.service==='ready'&&!history.results[0]?.stop&&!publicRun(history.results[0])?.stale?active:null),notebook_ref:history.results[0]?await storedRef(env,history.results[0]):cfg.kernel_ref,run: publicRun(history.results[0]), history: history.results.map(publicRun), config: {...effective,context_size:await contextSize(env,selected)},
        base_url: cfg.manager_url.replace(/\/$/, '') + '/v1'});
    }
    if (path === '/api/quota' && req.method === 'GET') {
      try {
        const q = await kaggleRpc(env, 'GetAcceleratorQuotaStatistics');
        const g = q.gpuQuota, used = duration(g?.timeUsed), total = duration(g?.totalTimeAllowed);
        if (used === null || total === null) return json({available: false, note: '配额数据格式未知，请以 Kaggle 页面为准'});
        return json({available: true, used_hours: used / 3600, total_hours: total / 3600,
          reserved_hours: (duration(g?.timeReserved) || 0) / 3600,
          remaining_hours: Math.max(0, total - used) / 3600, resets_at: q.quotaRefreshTime});
      } catch { return json({available: false, note: '配额接口不可用，请以 Kaggle 账号页面为准'}); }
    }
    if (req.method !== 'POST') fail(405, '仅支持 POST');
    if(path==='/api/model/select'){
      const body=await req.json(),model=await saveSelection(env,cfg,body.model_id),r=await latest(env),current=await runModel(env,r,cfg);
      if(r?.active&&current!==model.id)await update(env,r.id,{stop:1,note:'MODEL_SWITCH: waiting for confirmed Kaggle completion'});
      return json({selected_model:model.id,requires_restart:!!(r?.active&&current!==model.id),run:publicRun(await latest(env))});
    }
    if(path==='/api/context'){
      const b=await req.json();if(!CONTEXT_LENGTHS.includes(b.context_size))fail(400,'Choose a supported context length.');
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_options(name TEXT PRIMARY KEY,value TEXT NOT NULL)').run();
      await env.DB.prepare("INSERT INTO studio_options(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(cfg.model_profiles?.length?"context_size:"+(await selectedProfile(env,cfg)).id:"context_size",String(b.context_size)).run();
      return json({context_size:b.context_size,applies_to:'next_session'});
    }
    if (path === '/api/start') {
      validateConfig();
      if (!env.MODEL_API_KEY || env.MODEL_API_KEY.length < 24) fail(503, '请配置独立模型密钥');
      if (!env.KAGGLE_API_TOKEN && !env.KAGGLE_CREDENTIALS_KEY) fail(503, '请先连接 Kaggle');
      if (['named','vpc'].includes(cfg.tunnel_mode) && !env.CF_TUNNEL_TOKEN) fail(503, '请配置固定隧道 Token');
      if ((await latest(env))?.active) fail(409, '上次运行尚未确认结束，请先核实 Kaggle 实际运行情况');
      // Read-only authentication/connectivity check before reserving a run or requesting GPU.
      await listOwnKernels(env);
      const history=(await env.DB.prepare('SELECT * FROM runs ORDER BY requested DESC').all()).results;
      // Once any submission was attempted, never blindly create another notebook.
      // Source + run-token hashes bind legacy human-title slugs to this installation.
      const attempted=history.filter(r=>r.version||r.kaggle_state!=='ERROR'||!r.note?.startsWith('Kaggle rejected submission:'));
      const target=attempted.length?await findInstallationNotebook((op,b)=>kaggleRpc(env,op,b),{configuredRef:cfg.kernel_ref,managerUrl:cfg.manager_url,runs:attempted}):null;
      if(!target&&(await ownNotebookRefs((op,b)=>kaggleRpc(env,op,b),cfg.kernel_ref.split('/')[0])).includes(normalizeKernelRef(cfg.kernel_ref)))fail(409,'A notebook already uses this reference, but its deployment history is missing. No project was overwritten.');
      const id = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
      try {
        await env.DB.prepare('INSERT INTO runs(id,agent_hash,requested) VALUES (?,?,?)')
          .bind(id, await hash(token), sec()).run();
      } catch { fail(409, '上次运行尚未确认结束，请先刷新 Kaggle 状态或手动停止'); }
      const model=await selectedProfile(env,cfg),effective=profileConfig(cfg,model);
      await recordModel(env,id,model.id);
      const settings = {...effective, runtime_build:BUILD, context_size:await contextSize(env,model),studio_model_id:model.id, installation_id:env.STUDIO_INSTALLATION_ID||null, run_id: id, run_token: token};
      const runEnv = {...env, RUN_TOKEN: token};
      // Keep the active lock on uncertain network failure: Kaggle may have accepted it.
      await update(env, id, {kaggle_state: 'SUBMISSION_UNKNOWN'});
      let out;
      if(target)await rememberRef(env,id,target.ref);
      try {
        out = await kaggleRpc(runEnv, 'SaveKernel', notebookPayload(effective, settings,target));
      } catch(e) {
        await update(env, id, {note: redact(e.message, runEnv)});
        throw e;
      }
      if (!out.versionNumber) {
        // A structured rejection is definitive; malformed success remains uncertain.
        if (out.error || out.invalidDatasetSources?.length || out.invalidCompetitionSources?.length || out.invalidKernelSources?.length || out.invalidModelSources?.length) {
          const message = 'Kaggle rejected submission: ' + redact(out.error ||
            JSON.stringify({datasets: out.invalidDatasetSources, models: out.invalidModelSources,
              kernels: out.invalidKernelSources, competitions: out.invalidCompetitionSources}), runEnv);
          await update(env, id, {active: 0, ended: sec(), kaggle_state: 'ERROR', service: 'error', note: message});
          fail(502, message);
        }
        const message = 'SaveKernel returned no version number. Check Kaggle before submitting again.';
        await update(env, id, {note: message});
        fail(502, message);
      }
      const actualRef=normalizeKernelRef(out.ref||target?.ref||cfg.kernel_ref);
      if (!actualRef || actualRef.split('/')[0]!==cfg.kernel_ref.split('/')[0] || target&&actualRef!==target.ref) {
        const message = 'SaveKernel returned a different project reference: ' + redact(out.ref, env) + '. Check Kaggle; do not submit again.';
        await update(env, id, {note: message});
        fail(502, message);
      }
      if(!target&&actualRef!==cfg.kernel_ref){
        const [userName,kernelSlug]=actualRef.split('/'),notebook=await kaggleRpc(runEnv,'GetKernel',{userName,kernelSlug});
        if(!await matchesRunForSubmission(notebook,{id,agent_hash:await hash(token)}))fail(409,'The submitted notebook identity could not be confirmed. Check Kaggle before retrying.');
      }
      await rememberRef(env,id,actualRef);
      await update(env, id, {kaggle_state: 'QUEUED', version: String(out.versionNumber), note: ''});
      return json({run: publicRun(await latest(env))});
    }
    const r = await latest(env);
    if (!r) return json({run: null});
    if (path === '/api/stop') {
      if (r.active) await update(env, r.id, {stop: 1, note: '停止请求已登记，等待运行端及 Kaggle 确认'});
      return json({run: publicRun(await latest(env)), note: '排队中或失联时，请到 Kaggle 手动停止会话'});
    }
    if (path === '/api/refresh') {
      let [owner, slug] = (await storedRef(env,r)).split('/');
      if (!r.version) {
        if (!r.active) fail(409, 'No active run to recover.');
        // Recover an already-created version after an uncertain SaveKernel response.
        // Do not attach a previous/different run simply because its URL matches.
        const recovered=await recoverNotebook(env,r);
        const current=recovered.notebook,version=Number(current.metadata?.currentVersionNumber);
        if(!Number.isSafeInteger(version)||version<1)fail(409,'Cannot match the Kaggle version to this run.');
        [owner,slug]=recovered.ref.split('/');
        r.version = String(version);
        await update(env, r.id, {version: r.version, note: 'Recovered the existing Kaggle version. No new run was submitted.'});
      }
      let out;try{out=await kaggleRpc(env,'GetKernelSessionStatus',{userName:owner,kernelSlug:slug,versionLabel:'v'+r.version})}catch(e){
       if(![403,404].includes(e.http_status))throw e;const recovered=await recoverNotebook(env,r);[owner,slug]=recovered.ref.split('/');
       out=await kaggleRpc(env,'GetKernelSessionStatus',{userName:owner,kernelSlug:slug,versionLabel:'v'+r.version});
      }
      const state = normalizeState(out.status);
      await update(env, r.id, {kaggle_state: state, note: 'Kaggle status confirmed: '+state+'.',
        ...(TERMINAL.has(state) ? {active: 0, ended: r.ended || (r.service==='stopped'&&r.heartbeat?r.heartbeat:sec()), url: '', service: 'ended'} : {})});
      return json({run: publicRun(await latest(env))});
    }
    if (path === '/api/manual-ended') {
      const b = await req.json();
      if(b.run_id&&b.run_id!==r.id)fail(409,'The current run changed. Check Kaggle again before confirming.');
      if (b.confirm !== 'I_STOPPED_IN_KAGGLE') fail(400, '请先在 Kaggle 确认会话已停止');
      await update(env, r.id, {active: 0, ended: r.ended||r.heartbeat||sec(), url: '', service: 'ended', kaggle_state: 'MANUALLY_CONFIRMED', note: '用户确认已在 Kaggle 停止'});
      return json({run: publicRun(await latest(env))});
    }
    fail(404, '接口不存在');
  }
  if (path === '/' || path === '/index.html') {
    if (!env.ASSETS) return json({service:'Kaggle Studio manager', build:BUILD, setup:'Open the Studio app to manage this installation.'});
    const a = await env.ASSETS.fetch(req);
    return new Response(a.body, {status: a.status, headers: {...Object.fromEntries(a.headers),
      'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer'}});
  }
  fail(404, '页面不存在');
}
export default {async fetch(req, env) {
  try { return await route(req, env); }
  catch (e) { return json({error: e instanceof AppError || e.status ? redact(e.message, env) : '请求失败，请检查配置及 D1 初始化'}, e.status || 500); }
}};
