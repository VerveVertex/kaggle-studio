import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const config={...JSON.parse(readFileSync(new URL('../config.json',import.meta.url))),manager_url:'https://gpu.example.net',model_url:'https://llm.example.net',kernel_ref:'owner/server'};
const bundle=await build({entryPoints:['src/worker.js'],bundle:true,write:false,format:'esm',loader:{'.py':'text'},plugins:[{name:'test-config',setup(b){b.onLoad({filter:/config\.json$/},()=>({contents:JSON.stringify(config),loader:'json'}))}}]});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
const hash=async v=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))).toString('hex');
function env(){const sql=new DatabaseSync(':memory:');for(const f of ['schema.sql','auth.sql'])sql.exec(readFileSync(new URL('../'+f,import.meta.url),'utf8'));return {CF_OAUTH_CLIENT_ID:'test-client-id',CF_ACCOUNT_ID:'a'.repeat(32),CF_WORKER_NAME:'kaggle-gpu-manager',ADMIN_TOKEN:'original-admin-secret-000000000000',MODEL_API_KEY:'original-model-secret-000000000000',DB:{prepare(q){let args=[];return {bind(...v){args=v;return this},async first(){return sql.prepare(q).get(...args)||null},async run(){return sql.prepare(q).run(...args)},async all(){return {results:sql.prepare(q).all(...args)}}}}},_sql:sql};}
const call=(e,path,{method='GET',body,headers={}}={})=>worker.fetch(new Request(config.manager_url+path,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),e);
async function begin(e){const verifier='b'.repeat(64);const start=await call(e,'/connect/start',{method:'POST',body:{challenge:await hash(verifier),language:'zh-CN'}});assert.equal(start.status,200);const d=await start.json(),r=await call(e,'/connect/login?id='+d.id);assert.equal(r.status,302);return {...d,verifier,cookie:r.headers.get('Set-Cookie').split(';')[0],authorization:new URL(r.headers.get('Location'))};}
function cf(e,options={}){const original=globalThis.fetch,seen=[];globalThis.fetch=async(url,opts={})=>{url=String(url);seen.push([url,opts]);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'temporary-cf-token',token_type:'Bearer',scope:options.scope||'workers-scripts.edit'});if(url.endsWith('/oauth2/revoke'))return new Response(null,{status:200});assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${e.CF_ACCOUNT_ID}/workers/scripts/${e.CF_WORKER_NAME}/settings`);const ok=options.allowed!==false;return Response.json({success:ok,result:ok?{bindings:[]}:null},{status:ok?200:403});};return {seen,restore:()=>{globalThis.fetch=original}};}
const callback=async(e,p)=>{const r=await call(e,'/connect/callback?code=one-time-code&state='+p.id,{headers:{cookie:p.cookie}});if(r.status!==303)return r;const target=new URL(r.headers.get('Location'));assert.equal(target.origin,config.manager_url);assert.equal(target.pathname,'/connect/confirm');assert.equal(target.searchParams.get('id'),p.id);assert(!target.searchParams.has('code'));return call(e,target.pathname+target.search,{headers:{cookie:p.cookie}})};
const approve=(e,p,origin=config.manager_url)=>worker.fetch(new Request(config.manager_url+'/connect/approve',{method:'POST',headers:{cookie:p.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:p.id,decision:'approve'})}),e);
const finish=(e,p)=>call(e,'/connect/finish',{method:'POST',body:{id:p.id,verifier:p.verifier}});
const auth=key=>({headers:{Authorization:'Bearer '+key}});

test('unconfigured OAuth cannot mint keys',async()=>{const e=env();delete e.CF_OAUTH_CLIENT_ID;assert.equal((await (await call(e,'/connect/info')).json()).enabled,false);assert.equal((await call(e,'/connect/start',{method:'POST',body:{}})).status,503);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_devices').get().n,0);e._sql.close()});
test('canonical PKCE callback, browser cookie and device proof are enforced',async()=>{const e=env(),p=await begin(e);assert.equal(p.authorization.origin,'https://dash.cloudflare.com');assert.equal(p.authorization.searchParams.get('redirect_uri'),config.manager_url+'/connect/callback');assert.equal(p.authorization.searchParams.get('code_challenge_method'),'S256');assert.equal(p.authorization.searchParams.get('scope'),'workers-scripts.edit');assert.equal((await call(e,'/connect/callback?code=x&state='+p.id)).status,403);assert.equal((await call(e,'/connect/finish',{method:'POST',body:{id:p.id,verifier:'c'.repeat(64)}})).status,403);assert.equal((await (await finish(e,p)).json()).status,'pending');e._sql.close()});
test('explicit confirmation issues independent one-use device credentials and never exposes master or OAuth tokens',async()=>{const e=env(),p=await begin(e),f=cf(e);try{const r=await callback(e,p);assert.equal(r.status,200);const html=await r.text();assert(html.includes(p.confirmation_code));assert(!html.includes('temporary-cf-token'));assert.equal((await (await finish(e,p)).json()).status,'pending');assert.equal((await approve(e,p,'https://attacker.example')).status,403);assert.equal((await approve(e,p)).status,200);const d=await (await finish(e,p)).json();assert.equal(d.status,'connected');assert(d.manager_key.startsWith('studio_admin_'));assert(d.model_key.startsWith('studio_model_'));assert.notEqual(d.manager_key,d.model_key);assert(!JSON.stringify(d).includes(e.ADMIN_TOKEN));assert(!JSON.stringify(d).includes(e.MODEL_API_KEY));assert.equal(d.model_url,config.manager_url+'/v1');assert.equal((await finish(e,p)).status,409);assert(f.seen.some(([url])=>url.endsWith('/oauth2/revoke')));const db=JSON.stringify(e._sql.prepare('SELECT * FROM studio_devices').all());assert(!db.includes(d.manager_key));assert(!db.includes(d.model_key));const req=f.seen.find(([url])=>url.endsWith('/oauth2/token'))[1];assert.equal(new URLSearchParams(req.body).get('code_verifier').length,64);assert(!new URLSearchParams(req.body).has('client_secret'));}finally{f.restore();e._sql.close()}});
test('wrong account or insufficient scope cannot create devices',async()=>{for(const options of [{allowed:false},{scope:'workers-scripts.read'}]){const e=env(),p=await begin(e),f=cf(e,options);try{assert.equal((await callback(e,p)).status,403);assert.equal((await finish(e,p)).status,409);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_devices').get().n,0);}finally{f.restore();e._sql.close()}}});
test('expired and replayed responses and concurrent finish requests cannot issue extra credentials',async()=>{const e=env(),p=await begin(e),f=cf(e);try{await callback(e,p);assert.equal((await callback(e,p)).status,409);await approve(e,p);const res=await Promise.all([finish(e,p),finish(e,p)]);assert.deepEqual(res.map(r=>r.status).sort(),[200,409]);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_devices').get().n,1);const q=await begin(e);e._sql.prepare('UPDATE device_pairings SET expires=0 WHERE id=?').run(q.id);assert.equal((await finish(e,q)).status,410);}finally{f.restore();e._sql.close()}});
test('device role separation, model proxy, self revocation and expiry work alongside original admin access',async()=>{const e=env(),p=await begin(e),f=cf(e);let d;try{await callback(e,p);await approve(e,p);d=await (await finish(e,p)).json();}finally{f.restore()}assert.equal((await call(e,'/api/status',auth(d.manager_key))).status,200);assert.equal((await call(e,'/api/status',auth(d.model_key))).status,401);assert.equal((await call(e,'/v1/models',auth(d.manager_key))).status,401);assert.equal((await call(e,'/api/devices',auth(d.manager_key))).status,403);const time=Date.now()/1000;e._sql.prepare('INSERT INTO runs(id,agent_hash,requested,started,heartbeat,service,url) VALUES (?,?,?,?,?,?,?)').run('run','hash',time,time,time,'ready',config.model_url);const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{assert.equal(url,config.model_url+'/v1/models');assert.equal(options.headers.authorization,'Bearer '+e.MODEL_API_KEY);return Response.json({data:[{id:'actual-model'}]})};try{assert.equal((await call(e,'/v1/models',auth(d.model_key))).status,200);}finally{globalThis.fetch=original}assert.equal((await call(e,'/api/device/revoke',{method:'POST',...auth(d.manager_key)})).status,200);assert.equal((await call(e,'/api/status',auth(d.manager_key))).status,401);assert.equal((await call(e,'/v1/models',auth(d.model_key))).status,401);e._sql.prepare('UPDATE studio_devices SET revoked=0,expires=0').run();assert.equal((await call(e,'/api/status',auth(d.manager_key))).status,401);assert.equal((await call(e,'/api/status',auth(e.ADMIN_TOKEN))).status,200);e._sql.close()});
test('public requests are bounded and rate limited without requesting GPU resources',async()=>{const e=env();for(let i=0;i<6;i++)assert.equal((await call(e,'/connect/start',{method:'POST',body:{challenge:'e'.repeat(64)}})).status,200);assert.equal((await call(e,'/connect/start',{method:'POST',body:{challenge:'e'.repeat(64)}})).status,429);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM runs').get().n,0);e._sql.close()});

test('public setup diagnostics report the exact requested scope; old write-only grants cannot silently replace it',async()=>{const e=env();const info=await (await call(e,'/connect/info')).json();assert.equal(info.scope,'workers-scripts.edit');const p=await begin(e),f=cf(e,{scope:'workers-scripts.write'});try{assert.equal((await callback(e,p)).status,403);assert.equal((await finish(e,p)).status,409);assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_devices').get().n,0);}finally{f.restore();e._sql.close()}});

test('HTML confirmation preserves same-origin POST Origin without exposing the OAuth code; null and missing Origins still fail',async()=>{
 const e=env(),p=await begin(e),f=cf(e);
 try{
  const raw=await call(e,'/connect/callback?code=sensitive-one-time-code&state='+p.id,{headers:{cookie:p.cookie}});
  assert.equal(raw.status,303);assert(!raw.headers.get('Location').includes('code='));
  const url=new URL(raw.headers.get('Location'));
  assert.equal((await call(e,url.pathname+url.search)).status,403,'confirmation requires the same browser cookie');
  const page=await call(e,url.pathname+url.search,{headers:{cookie:p.cookie}});
  assert.equal(page.status,200);assert.equal(page.headers.get('Referrer-Policy'),'same-origin');
  assert(page.headers.get('Content-Security-Policy').includes("form-action 'self'"));
  const html=await page.text();assert(!html.includes('sensitive-one-time-code'));
  assert(html.includes('method="post"'));assert(html.includes(config.manager_url+'/connect/approve'));
  assert.equal((await approve(e,p,'null')).status,403);
  assert.equal((await worker.fetch(new Request(config.manager_url+'/connect/approve',{method:'POST',headers:{cookie:p.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:p.id,decision:'approve'})}),e)).status,403);
  assert.equal(e._sql.prepare('SELECT state FROM device_pairings WHERE id=?').get(p.id).state,'confirm');
  assert.equal((await approve(e,p,'https://another.example')).status,403);
  assert.equal((await approve(e,p)).status,200);
  assert.equal((await (await finish(e,p)).json()).status,'connected');
 }finally{f.restore();e._sql.close()}
});

test('deleting an expired or revoked device removes only its own D1 row and leaves original Secrets, other devices and GPU runs untouched',async()=>{
 const e=env(),a='studio_admin_'+'1'.repeat(64),am='studio_model_'+'2'.repeat(64),b='studio_admin_'+'3'.repeat(64),bm='studio_model_'+'4'.repeat(64);
 e.KAGGLE_API_TOKEN='original-kaggle-key';e.CF_TUNNEL_TOKEN='original-tunnel-key';
 const originalKeys={ADMIN_TOKEN:e.ADMIN_TOKEN,MODEL_API_KEY:e.MODEL_API_KEY,KAGGLE_API_TOKEN:e.KAGGLE_API_TOKEN,CF_TUNNEL_TOKEN:e.CF_TUNNEL_TOKEN};
 e._sql.prepare('INSERT INTO studio_devices(id,manager_hash,model_hash,created,expires,revoked) VALUES (?,?,?,?,?,?)').run('device-a',await hash(a),await hash(am),1,2,1);
 e._sql.prepare('INSERT INTO studio_devices(id,manager_hash,model_hash,created,expires,revoked) VALUES (?,?,?,?,?,?)').run('device-b',await hash(b),await hash(bm),1,Date.now()/1000+1000,0);
 e._sql.prepare('INSERT INTO runs(id,agent_hash,requested) VALUES (?,?,?)').run('gpu-session','not-a-device-key',Date.now()/1000);
 const otherBefore=e._sql.prepare('SELECT * FROM studio_devices WHERE id=?').get('device-b');
 delete e.CF_OAUTH_CLIENT_ID;const originalFetch=globalThis.fetch;let requests=0;globalThis.fetch=async()=>{requests++;throw Error('deletion must not call Cloudflare or Kaggle APIs')};
 try{
  assert.equal((await call(e,'/api/status',auth(a))).status,401,'expired keys cannot use regular management endpoints');
  for(const key of [e.ADMIN_TOKEN,e.MODEL_API_KEY,am,'wrong-key'])assert.equal((await call(e,'/connect/device/delete',{method:'POST',...auth(key)})).status,401);
  const response=await call(e,'/connect/device/delete',{method:'POST',body:{id:'device-b'},...auth(a)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,device_deleted:true,scope:'current_device'});
  assert.equal(e._sql.prepare('SELECT * FROM studio_devices WHERE id=?').get('device-a'),undefined);
  assert.deepEqual(e._sql.prepare('SELECT * FROM studio_devices WHERE id=?').get('device-b'),otherBefore);
  assert.equal((await call(e,'/api/status',auth(b))).status,200);assert.equal((await call(e,'/api/status',auth(e.ADMIN_TOKEN))).status,200);
  assert.equal((await call(e,'/v1/models',auth(am))).status,401);
  const run=e._sql.prepare('SELECT active,stop FROM runs WHERE id=?').get('gpu-session');assert.equal(run.active,1);assert.equal(run.stop,0);
  assert.deepEqual(Object.fromEntries(Object.keys(originalKeys).map(k=>[k,e[k]])),originalKeys);assert.equal(requests,0);
  const retry=await call(e,'/connect/device/delete',{method:'POST',...auth(a)});assert.equal(retry.status,200);assert.equal((await retry.json()).device_deleted,false);
 }finally{globalThis.fetch=originalFetch;e._sql.close()}
});
test('device deletion rejects cross-origin requests and missing or wrong-role credentials',async()=>{
 const e=env(),token='studio_admin_'+'5'.repeat(64);e._sql.prepare('INSERT INTO studio_devices(id,manager_hash,model_hash,created,expires) VALUES (?,?,?,?,?)').run('mine',await hash(token),'model-hash',1,2);
 for(const origin of ['https://evil.example','null'])assert.equal((await call(e,'/connect/device/delete',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token}})).status,403);
 assert.equal((await call(e,'/connect/device/delete',{method:'POST'})).status,401);
 assert.equal(e._sql.prepare('SELECT count(*) AS n FROM studio_devices').get().n,1);
 assert.equal((await call(e,'/connect/device/delete',{method:'POST',...auth(token)})).status,200);
 e._sql.close();
});
