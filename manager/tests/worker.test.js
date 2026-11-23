import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {normalizeKernelRef, settingsFromSource} from '../src/kaggle.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
Object.assign(config, {manager_url: 'https://gpu.test.net', model_url: 'https://llm.test.net', kernel_ref: 'tester/managed-qwen-server'});
const bundle = await build({entryPoints: ['src/worker.js'], bundle: true, write: false, format: 'esm',
  loader: {'.py': 'text'}, plugins: [{name: 'test-config', setup(b) {
    b.onLoad({filter: /config\.json$/}, () => ({contents: JSON.stringify(config), loader: 'json'}));
  }}]});
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const worker = mod.default;
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const admin = 'admin-test-0000000000000000000000', model = 'model-test-0000000000000000000000';
function env() {
  const sql = new DatabaseSync(':memory:'); sql.exec(schema);
  return {ADMIN_TOKEN: admin, MODEL_API_KEY: model, KAGGLE_API_TOKEN: 'not-a-real-token', CF_TUNNEL_TOKEN: 'tunnel-test',
    ASSETS: {fetch: async () => new Response('<html>test</html>')},
    DB: {prepare(query) {let values=[];return {bind(...args) {values=args;return this;},
      async run() {return sql.prepare(query).run(...values);},
      async first() {return sql.prepare(query).get(...values)||null;},
      async all() {return {results: sql.prepare(query).all(...values)};}};}}, _sql: sql};
}
function call(e, path, method='GET', body, key=admin) {
  return worker.fetch(new Request('https://gpu.test.net'+path,{method,
    headers:{authorization:'Bearer '+key,'content-type':'application/json'}, body:body?JSON.stringify(body):undefined}),e);
}
test('URL validation rejects private addresses, alternate ports, credentials and path injection', () => {
  assert(mod.safeUrl('https://foo.trycloudflare.com',config));
  assert(mod.safeUrl('https://llm.test.net',config));
  for (const u of ['http://foo.trycloudflare.com','https://127.0.0.1','https://localhost',
    'https://foo.trycloudflare.com:444','https://user@foo.trycloudflare.com','https://foo.trycloudflare.com/evil',
    'https://foo.trycloudflare.com?x=1','https://foo.trycloudflare.com.evil.net']) assert(!mod.safeUrl(u,config),u);
});
test('Kaggle enum and protobuf duration formats are decoded', () => {
  assert.equal(mod.normalizeState(2),'COMPLETE');assert.equal(mod.normalizeState('running'),'RUNNING');
  assert.equal(mod.duration('108000.000s'),108000);assert.equal(mod.duration({seconds:'120'}),120);
  assert.equal(mod.duration('unexpected'),null);
});
test('Kaggle returns equivalent bare references, code paths and full URLs', () => {
  for(const ref of ['tester/managed-qwen-server','/code/tester/managed-qwen-server',
    '/code/Tester/managed-qwen-server/','https://www.kaggle.com/code/tester/managed-qwen-server',
    'https://kaggle.com/code/tester/managed-qwen-server?scriptVersionId=7'])
    assert.equal(normalizeKernelRef(ref),'tester/managed-qwen-server');
  for(const ref of ['https://example.com/code/tester/managed-qwen-server',
    'https://www.kaggle.com.evil.org/code/tester/managed-qwen-server',
    'https://user@www.kaggle.com/code/tester/managed-qwen-server',
    '/code/tester/managed-qwen-server/7','tester/../other','javascript:alert(1)',null])
    assert.equal(normalizeKernelRef(ref),null);
});
test('notebook JSON serializes safely into valid Python, without admin or Kaggle secrets', () => {
  const p=mod.notebookPayload(config,{...config,run_id:'test',run_token:'special"\\\n中文'});
  assert(p.isPrivate);assert.equal(p.machineShape,'NvidiaTeslaT4');assert.equal(p.sessionTimeoutSeconds,43200);
  const proc=spawnSync('python',['-c','import sys; compile(sys.stdin.read(), "runner", "exec")'],{input:p.text,encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr);assert(!p.text.includes(admin));assert(!p.text.includes('not-a-real-token'));
});
test('control lifecycle: auth, duplicate starts, bootstrap, proxy, stop, status confirmation and stale callbacks', async () => {
  const e=env(), original=globalThis.fetch;let pushes=0, script='';
  globalThis.fetch=async (url, options={})=>{
    if(url.endsWith('/ListKernels'))return Response.json({kernels:script?[{ref:config.kernel_ref}]:[]});
    if(url.endsWith('/GetKernel'))return Response.json({metadata:{id:19,ref:config.kernel_ref,title:config.kernel_title,currentVersionNumber:7},blob:{source:script}});
    if(url.endsWith('/SaveKernel')){assert.equal(options.method,'POST');if(pushes)assert.equal(JSON.parse(options.body).id,19);pushes++;script=JSON.parse(options.body).text;return Response.json({versionNumber:7,ref:'/code/'+config.kernel_ref});}
    if(url.endsWith('/GetKernelSessionStatus')){assert.equal(JSON.parse(options.body).versionLabel,'v7');return Response.json({status:2});}
    if(url.startsWith('https://llm.test.net/v1/'))return new Response('data: hello\n\n',{headers:{'content-type':'text/event-stream'}});
    throw Error('unexpected external request');
  };
  try {
    assert.equal((await call(e,'/api/status','GET',null,'bad')).status,401);
    const concurrent=await Promise.all([call(e,'/api/start','POST'),call(e,'/api/start','POST')]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);assert.equal(pushes,1);
    const token=JSON.parse(JSON.parse(script.split('\n')[1].slice('SETTINGS = json.loads('.length,-1))).run_token;
    let s=await (await call(e,'/api/status')).json();const id=s.run.id;
    assert(!JSON.stringify(s).includes(token));assert(!JSON.stringify(s).includes('agent_hash'));
    const agentPath='/agent/'+id;
    assert.equal((await call(e,agentPath,'POST',{state:'starting'},'wrong')).status,401);
    const boot=await (await call(e,agentPath,'POST',{state:'starting',bootstrap:true},token)).json();
    assert.equal(boot.model_api_key,model);assert.equal(boot.tunnel_token,'tunnel-test');
    assert.equal((await call(e,agentPath,'POST',{state:'ready',url:'https://127.0.0.1'},token)).status,400);
    await call(e,agentPath,'POST',{state:'ready',url:'https://llm.test.net'},token);
    const proxy=await call(e,'/v1/chat/completions','POST',{stream:true},model);
    assert.equal(proxy.status,200);assert.equal(await proxy.text(),'data: hello\n\n');
    assert.equal((await call(e,'/v1/models','GET',null,admin)).status,401);
    await call(e,'/api/stop','POST');
    assert.equal((await call(e,'/v1/models','GET',null,model)).status,503);
    assert((await (await call(e,agentPath,'POST',{state:'ready'},token)).json()).stop);
    await call(e,agentPath,'POST',{state:'stopped'},token);
    assert.equal((await call(e,'/api/start','POST')).status,409,'process exit is not a released Kaggle session');
    await call(e,'/api/refresh','POST');
    s=await (await call(e,'/api/status')).json();assert.equal(s.run.active,0);assert.equal(s.run.url,'');
    const ended=await (await call(e,agentPath,'POST',{state:'ready',url:'https://llm.test.net'},token)).json();assert(ended.stop);
    assert.equal((await (await call(e,'/api/status')).json()).run.url,'');
    assert.equal((await call(e,'/api/start','POST')).status,200);
    assert.equal((await call(e,agentPath,'POST',{state:'ready'},token)).status,409);
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('network failure retains active lock; manual confirmation requires explicit acknowledgement', async () => {
  const e=env(), original=globalThis.fetch;globalThis.fetch=async(url)=>{
    if(url.endsWith('/ListKernels'))return Response.json({});
    throw Error('network timeout');
  };
  try {
    assert.equal((await call(e,'/api/start','POST')).status,502);
    assert.equal((await call(e,'/api/start','POST')).status,409);
    assert.equal((await call(e,'/api/manual-ended','POST',{})).status,400);
    assert.equal((await call(e,'/api/manual-ended','POST',{confirm:'I_STOPPED_IN_KAGGLE'})).status,200);
    assert.equal((await (await call(e,'/api/status')).json()).run.active,0);
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('read-only diagnostics preserves unknown lock and never submits a kernel', async () => {
  const e=env(), original=globalThis.fetch, requests=[];
  e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,kaggle_state) VALUES (?,?,?,?)')
    .run('uncertain','hash',Date.now()/1000,'SUBMISSION_UNKNOWN');
  globalThis.fetch=async(url,options)=>{
    requests.push(url);
    assert.equal(options.method,'POST');
    assert(url.startsWith('https://api.kaggle.com/v1/kernels.KernelsApiService/'));
    if(url.endsWith('/ListKernels')) {
      assert.equal(JSON.parse(options.body).group,'PROFILE');
      return Response.json({kernels:[{ref:'tester/old-notebook'}]});
    }
    if(url.endsWith('/GetKernelSessionStatus'))return Response.json({error:{code:404,message:'Not found'}},{status:404});
    throw Error('diagnostics attempted a mutation');
  };
  try {
    assert.equal((await call(e,'/api/diagnostics','GET',null,'wrong')).status,401);
    assert.equal(requests.length,0);
    const d=await (await call(e,'/api/diagnostics')).json();
    assert.equal(d.build,'0.3.0');assert(d.read_only);assert.equal(d.checks[0].ok,true);
    assert.equal(d.checks[1].ok,false);assert(d.checks[1].error.includes('404'));
    assert(!JSON.stringify(d).includes(e.KAGGLE_API_TOKEN));
    assert.equal(e._sql.prepare('SELECT active FROM runs').get().active,1);
    assert.equal(requests.length,2);
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('preflight auth failure returns detail without inserting a run or requesting GPU', async () => {
  const e=env(), original=globalThis.fetch;let n=0;
  globalThis.fetch=async(url)=>{n++;assert(url.endsWith('/ListKernels'));
    return Response.json({error:{code:401,message:'Unauthenticated '+e.KAGGLE_API_TOKEN}},{status:401});};
  try {
    const res=await call(e,'/api/start','POST'), data=await res.json();
    assert.equal(res.status,502);assert(data.error.includes('401'));
    assert(!data.error.includes(e.KAGGLE_API_TOKEN));
    assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,0);assert.equal(n,1);
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('SaveKernel redirect is not followed or retried, and reason persists in status', async () => {
  const e=env(), original=globalThis.fetch;let saves=0;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/ListKernels'))return Response.json({});
    assert(url.endsWith('/SaveKernel'));saves++;assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://example.org/sign-in?token=do-not-display'}});
  };
  try {
    const res=await call(e,'/api/start','POST'),d=await res.json();
    assert.equal(res.status,502);assert(d.error.includes('302'));assert(!d.error.includes('do-not-display'));
    const run=(await (await call(e,'/api/status')).json()).run;
    assert.equal(run.active,1);assert.equal(run.kaggle_state,'SUBMISSION_UNKNOWN');assert(run.note.includes('redirect'));
    assert.equal((await call(e,'/api/start','POST')).status,409);assert.equal(saves,1);
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('explicit Kaggle rejection is recorded and releases lock; timeout does not', async () => {
  const e=env(), original=globalThis.fetch;
  globalThis.fetch=async(url)=>url.endsWith('/ListKernels')?Response.json({}):
    Response.json({error:'Dataset not accessible',invalidDatasetSources:['owner/private']});
  try {
    assert.equal((await call(e,'/api/start','POST')).status,502);
    let run=(await (await call(e,'/api/status')).json()).run;
    assert.equal(run.active,0);assert(run.note.includes('Dataset not accessible'));
    globalThis.fetch=async(url)=>{if(url.endsWith('/ListKernels'))return Response.json({});throw new DOMException('private error','TimeoutError')};
    const result=await (await call(e,'/api/start','POST')).json();assert(result.error.includes('25 seconds'));
    run=(await (await call(e,'/api/status')).json()).run;assert.equal(run.active,1);assert(run.note.includes('timed out'));
  } finally {globalThis.fetch=original;e._sql.close();}
});
test('stale heartbeats cannot serve model traffic; expired run receives stop instruction', async () => {
  const e=env(), token='agent-testing-token';
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  const now=Date.now()/1000;
  e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,started,heartbeat,service,url) VALUES (?,?,?,?,?,?,?)')
    .run('old',digest,now-44000,now-44000,now-100,'ready','https://llm.test.net');
  assert.equal((await call(e,'/v1/models','GET',null,model)).status,503);
  const d=await (await call(e,'/agent/old','POST',{state:'ready'},token)).json();assert(d.stop);
  e._sql.close();
});
test('refresh recovers only the matching submitted source without requesting another run', async()=>{
  const e=env(),original=globalThis.fetch,token='ephemeral-run-token-recovery',id='recover-existing';
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,kaggle_state,note) VALUES (?,?,?,?,?)')
    .run(id,digest,Date.now()/1000,'SUBMISSION_UNKNOWN','Old reference-format mismatch');
  const settings={...config,run_id:id,run_token:token};
  const source=mod.notebookPayload(config,settings).text;
  assert.deepEqual(settingsFromSource(source),settings);
  assert.equal(settingsFromSource('import os\nos.system("bad")'),null);
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push(url);
    if(url.endsWith('/GetKernel'))return Response.json({metadata:{ref:'/code/'+config.kernel_ref,currentVersionNumber:3},blob:{source}});
    assert(url.endsWith('/GetKernelSessionStatus'));assert.equal(JSON.parse(options.body).versionLabel,'v3');
    return Response.json({status:'RUNNING'});
  };
  try {
    const response=await call(e,'/api/refresh','POST');assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.run.version,'3');assert.equal(result.run.active,1);
    assert.equal(result.run.kaggle_state,'RUNNING');assert(!JSON.stringify(result).includes(token));
    assert.equal(calls.length,2);assert(calls.every(u=>!u.endsWith('/SaveKernel')));
  }finally{globalThis.fetch=original;e._sql.close();}
});
test('recovery rejects a different run or wrong agent token and never clears the lock',async()=>{
  for(const override of [{run_id:'different'}, {run_token:'incorrect'}, {kernel_ref:'tester/other'}]) {
    const e=env(),original=globalThis.fetch,token='good-agent-token',id='cannot-adopt-other';
    const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
    e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,kaggle_state) VALUES (?,?,?,?)').run(id,digest,1,'SUBMISSION_UNKNOWN');
    const source=mod.notebookPayload(config,{...config,run_id:id,run_token:token,...override}).text;
    globalThis.fetch=async(url)=>{if(url.endsWith('/ListKernels'))return Response.json({kernels:[]});assert(url.endsWith('/GetKernel'));return Response.json({metadata:{currentVersionNumber:9},blob:{source}});};
    try{
      const res=await call(e,'/api/refresh','POST');assert.equal(res.status,409);
      const run=e._sql.prepare('SELECT * FROM runs').get();assert.equal(run.active,1);assert.equal(run.version,null);
    }finally{globalThis.fetch=original;e._sql.close();}
  }
});
test('a genuinely different returned project remains uncertain and blocks duplicate submission',async()=>{
  const e=env(),original=globalThis.fetch;let saves=0;
  globalThis.fetch=async(url)=>{
    if(url.endsWith('/ListKernels'))return Response.json({});
    saves++;return Response.json({ref:'/code/another-user/other-project',versionNumber:5});
  };
  try{
    const res=await call(e,'/api/start','POST');assert.equal(res.status,502);
    assert((await res.json()).error.includes('different project'));
    assert.equal((await call(e,'/api/start','POST')).status,409);assert.equal(saves,1);
  }finally{globalThis.fetch=original;e._sql.close();}
});
test('model discovery reads the actual Kaggle notebook declaration without returning private source',async()=>{
 const e=env(),original=globalThis.fetch;let requests=0;
 const source=mod.notebookPayload(config,{...config,model_alias:'custom-model-from-kaggle',run_id:'private-id',run_token:'private-callback-credential'}).text;
 globalThis.fetch=async(url,options)=>{
   requests++;assert(url.endsWith('/GetKernel'));assert.equal(options.method,'POST');
   assert.deepEqual(JSON.parse(options.body),{userName:'tester',kernelSlug:'managed-qwen-server'});
   return Response.json({metadata:{ref:'/code/'+config.kernel_ref,title:'Notebook title',currentVersionNumber:12,
     modelDataSources:['owner/weights/gguf/quantized/1']},blob:{source}});
 };
 try{
   assert.equal((await call(e,'/api/models','GET',null,'bad')).status,401);assert.equal(requests,0);
   const res=await call(e,'/api/models'),data=await res.json();assert.equal(res.status,200);
   assert(data.read_only);assert.equal(data.models[0].id,'custom-model-from-kaggle');
   assert.equal(data.models[0].status,'configured');assert.equal(data.notebook.version,12);
   assert(!JSON.stringify(data).includes('private-callback-credential'));assert(!JSON.stringify(data).includes('SETTINGS'));
   assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,0);assert.equal(requests,1);
 }finally{globalThis.fetch=original;e._sql.close();}
});
test('unrecognized notebooks expose assets as assets and never invent a serving model ID',async()=>{
 const e=env(),original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({metadata:{ref:config.kernel_ref,modelDataSources:['owner/weights/gguf/variant/1']},blob:{source:'print("custom script")'}});
 try{
   const d=await (await call(e,'/api/models')).json();assert.deepEqual(d.models,[]);
   assert.deepEqual(d.model_assets,['owner/weights/gguf/variant/1']);assert(d.note.includes('not inference endpoints'));
 }finally{globalThis.fetch=original;e._sql.close();}
});

test('a title-generated legacy slug is recovered by the exact run hash and terminal state releases the old lock',async()=>{
 const e=env(),original=globalThis.fetch,id='legacy-stop',token='legacy-run-token',ref='tester/studio-qwen-gguf-t4-2';
 const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
 e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,started,heartbeat,version,stop,service) VALUES (?,?,?,?,?,?,?,?)').run(id,digest,1000,1001,1121,'4',1,'stopped');
 const source=mod.notebookPayload(config,{...config,run_id:id,run_token:token}).text;let saves=0;
 globalThis.fetch=async(url,o)=>{const b=JSON.parse(o.body);if(url.endsWith('/SaveKernel')){saves++;throw Error('Must never resubmit')}
  if(url.endsWith('/ListKernels'))return Response.json({kernels:[{ref},{ref:'tester/studio-other-users-project'}]});
  if(b.kernelSlug==='managed-qwen-server')return Response.json({error:{message:"Permission 'kernels.get' was denied"}},{status:403});
  if(url.endsWith('/GetKernel'))return Response.json({metadata:{ref:'tester/'+b.kernelSlug,currentVersionNumber:4},blob:{source:b.kernelSlug===ref.split('/')[1]?source:'print("unrelated")'}});
  assert(url.endsWith('/GetKernelSessionStatus'));assert.equal(b.kernelSlug,ref.split('/')[1]);assert.equal(b.versionLabel,'v4');return Response.json({status:'COMPLETE'});
 };
 try{
  const r=await call(e,'/api/refresh','POST');assert.equal(r.status,200);const data=await r.json();assert.equal(data.run.active,0);assert.equal(data.run.ended,1121);assert.equal(data.run.kaggle_state,'COMPLETE');assert.equal(saves,0);
  const models=await (await call(e,'/api/models')).json();assert.equal(models.notebook.ref,ref);assert(!JSON.stringify(models).includes(token));
 }finally{globalThis.fetch=original;e._sql.close()}
});

test('a terminal snapshot labels delayed observation instead of claiming the offline gap as runtime',async()=>{const e=env();e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,started,heartbeat,ended,active,service) VALUES (?,?,?,?,?,?,?,?)').run('late','hash',1000,1001,1121,9000,0,'ended');const data=await (await call(e,'/api/status')).json();assert.equal(data.run.ended_estimate_only,true);e._sql.close()});

test('manual confirmation is bound to its displayed run and preserves the last heartbeat duration',async()=>{
 const e=env();e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,started,heartbeat,active,stop) VALUES (?,?,?,?,?,?,?)').run('current-run','hash',100,101,201,1,1);
 assert.equal((await call(e,'/api/manual-ended','POST',{confirm:'I_STOPPED_IN_KAGGLE',run_id:'previous-run'})).status,409);
 assert.equal(e._sql.prepare('SELECT active FROM runs').get().active,1);
 const response=await call(e,'/api/manual-ended','POST',{confirm:'I_STOPPED_IN_KAGGLE',run_id:'current-run'});assert.equal(response.status,200);const data=await response.json();assert.equal(data.run.active,0);assert.equal(data.run.ended,201);assert.equal(data.run.kaggle_state,'MANUALLY_CONFIRMED');e._sql.close();
});

test('legacy Qwen T4 notebook is reused by verified numeric ID across repair-style title changes and restarts',async()=>{
 const e=env(),original=globalThis.fetch,ref='tester/qwen-gguf4t-2',runToken='legacy-run-proof',id='original-good-run';
 const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(runToken))).toString('hex');
 e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,active,ended,version,kaggle_state) VALUES (?,?,?,?,?,?,?)').run(id,digest,1,0,2,'3','COMPLETE');
 let source=mod.notebookPayload({...config,kernel_title:'Qwen GGUF4T×2'},{...config,run_id:id,run_token:runToken}).text,saves=0;
 globalThis.fetch=async(url,o)=>{
  const body=JSON.parse(o.body||'{}');
  if(url.endsWith('/ListKernels'))return Response.json({kernels:[{ref},{ref:'tester/unrelated-project'}]});
  if(url.endsWith('/GetKernel'))return body.kernelSlug==='qwen-gguf4t-2'?Response.json({metadata:{id:123456,ref,title:'Qwen GGUF4T×2',currentVersionNumber:3+saves},blob:{source}}):Response.json({metadata:{ref:'tester/unrelated-project'},blob:{source:'print("unrelated")'}});
  if(url.endsWith('/SaveKernel')){assert.equal(body.id,123456);assert.equal(body.slug,ref);assert.equal(body.newTitle,'Qwen GGUF4T×2');assert.equal(body.machineShape,'NvidiaTeslaT4');assert.equal(settingsFromSource(body.text).kernel_ref,config.kernel_ref);source=body.text;saves++;return Response.json({versionNumber:3+saves,ref})}
  if(url.endsWith('/GetKernelSessionStatus')){assert.equal(body.kernelSlug,'qwen-gguf4t-2');return Response.json({status:'COMPLETE'})}
  throw Error('Unexpected external request');
 };
 try{
  for(let n=0;n<2;n++){const response=await call(e,'/api/start','POST');assert.equal(response.status,200,await response.clone().text());const status=await (await call(e,'/api/status')).json();assert.equal(status.notebook_ref,ref);await call(e,'/api/refresh','POST');}
  assert.equal(saves,2);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_run_refs').get().n,2);
 }finally{globalThis.fetch=original;e._sql.close()}
});

test('missing or ambiguous previously submitted notebooks cannot silently create another project',async()=>{
 for(const ambiguous of [false,true]){
  const e=env(),original=globalThis.fetch,token='history-proof';let saves=0;
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,active,ended,version) VALUES (?,?,?,?,?,?)').run('old',digest,1,0,2,'1');
  const source=mod.notebookPayload(config,{...config,run_id:'old',run_token:token}).text;
  globalThis.fetch=async(url,o)=>{if(url.endsWith('/ListKernels'))return Response.json({kernels:ambiguous?[{ref:'tester/a'},{ref:'tester/b'}]:[]});if(url.endsWith('/GetKernel'))return Response.json({blob:{source}});if(url.endsWith('/SaveKernel'))saves++;throw Error('Unexpected mutation')};
  try{const response=await call(e,'/api/start','POST');assert.equal(response.status,409);assert.equal(saves,0);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,1)}finally{globalThis.fetch=original;e._sql.close()}
 }
});

test('context changes are authenticated, bounded, persistent and passed to the next notebook',async()=>{
 const e=env(),original=globalThis.fetch;let submitted;
 globalThis.fetch=async(url,o)=>{if(url.endsWith('/ListKernels'))return Response.json({});submitted=JSON.parse(o.body);return Response.json({ref:config.kernel_ref,versionNumber:1})};
 try{
  assert.equal((await call(e,'/api/context','POST',{context_size:16384},'bad')).status,401);
  assert.equal((await call(e,'/api/context','POST',{context_size:999999})).status,400);
  assert.equal((await call(e,'/api/context','POST',{context_size:16384})).status,200);
  const status=await (await call(e,'/api/status')).json();assert.equal(status.config.context_size,16384);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,0);
  assert.equal((await call(e,'/api/start','POST')).status,200);assert.equal(settingsFromSource(submitted.text).context_size,16384);
 }finally{globalThis.fetch=original;e._sql.close()}
});

test('a first-start name collision cannot overwrite an existing unverified notebook',async()=>{
 const e=env(),original=globalThis.fetch;let saves=0;
 globalThis.fetch=async(url)=>{if(url.endsWith('/ListKernels'))return Response.json({kernels:[{ref:config.kernel_ref}]});saves++;throw Error('Unexpected mutation')};
 try{assert.equal((await call(e,'/api/start','POST')).status,409);assert.equal(saves,0);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,0)}finally{globalThis.fetch=original;e._sql.close()}
});
