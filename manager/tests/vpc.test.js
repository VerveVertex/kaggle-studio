import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {kaggleAccessToken,decryptCredential} from '../src/kaggle-oauth.js';
import {seal,sha256} from '../../android/web/src/setup/crypto.mjs';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url)));
Object.assign(config,{manager_url:'https://studio.test.net',kernel_ref:'tester/studio-001122334455',model_url:'https://studio-vpc.invalid',tunnel_mode:'vpc'});
const bundle=await build({entryPoints:['src/worker.js'],bundle:true,write:false,format:'esm',loader:{'.py':'text'},plugins:[{name:'config',setup(b){b.onLoad({filter:/config\.json$/},()=>({contents:JSON.stringify(config),loader:'json'}))}}]});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
function database(){const db=new DatabaseSync(':memory:');for(const f of ['schema.sql','auth.sql','installer.sql'])db.exec(readFileSync(new URL('../'+f,import.meta.url),'utf8'));return {raw:db,prepare(sql){return {values:[],bind(...v){this.values=v;return this},async first(){return db.prepare(sql).get(...this.values)||null},async all(){return {results:db.prepare(sql).all(...this.values)}},async run(){return db.prepare(sql).run(...this.values)}}}}}
const admin='admin-'+'a'.repeat(32),model='model-'+'b'.repeat(32),runToken='agent-private-fixture';
const request=(path,key,body)=>new Request('https://studio.test.net'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
test('private tunnel is probed before ready and preserves streaming without a public origin URL',async()=>{
 let reachable=false,calls=[];const db=database(),env={DB:db,ADMIN_TOKEN:admin,MODEL_API_KEY:model,KAGGLE_API_TOKEN:'fixture-kaggle',CF_TUNNEL_TOKEN:'fixture-tunnel',MODEL_VPC:{fetch:async(url,options)=>{calls.push([url,options]);if(!reachable)throw Error('no QUIC');return url.endsWith('/models')?Response.json({data:[{id:'fixture-model'}]}):new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}}};
 db.raw.prepare('INSERT INTO runs(id,agent_hash,requested,service) VALUES (?,?,?,?)').run('run',await sha256(runToken),Date.now()/1000,'loading');
 let r=await worker.fetch(request('/agent/run',runToken,{state:'loading',probe:true}),env);assert.equal((await r.json()).model_reachable,false);
 r=await worker.fetch(request('/agent/run',runToken,{state:'ready'}),env);assert.equal(r.status,503);assert.equal(db.raw.prepare('SELECT service FROM runs').get().service,'loading');
 reachable=true;r=await worker.fetch(request('/agent/run',runToken,{state:'ready',bootstrap:true}),env);assert.equal(r.status,200);assert.equal((await r.json()).tunnel_token,'fixture-tunnel');
 r=await worker.fetch(request('/v1/chat/completions',model,{stream:true,messages:[]}),env);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'text/event-stream');assert((await r.text()).includes('[DONE]'));
 const last=calls.at(-1);assert.equal(last[0],'http://llama/v1/chat/completions');assert.equal(last[1].headers.authorization,'Bearer '+model);assert.equal(last[1].redirect,'manual');
 db.raw.prepare('UPDATE runs SET stop=1').run();const n=calls.length;r=await worker.fetch(request('/v1/models',model),env);assert.equal(r.status,503);assert.equal(calls.length,n);
});
async function oauthEnv(expiry){
 const env={DB:database(),STUDIO_INSTALLATION_ID:'id-test',KAGGLE_CREDENTIALS_KEY:'a'.repeat(64)};
 const credential={accessToken:'expired-private-test',refreshToken:'refresh-private-test',clientId:'studio-public-test',expires:expiry};
 const encrypted=await seal(env.KAGGLE_CREDENTIALS_KEY,JSON.stringify(credential),'kaggle:'+env.STUDIO_INSTALLATION_ID);
 env.DB.raw.prepare("INSERT INTO provider_credentials(provider,sealed) VALUES ('kaggle',?)").run(encrypted);return env;
}
test('Kaggle refresh is encrypted, single-flight and persists a rotated token without Cloudflare admin access',async()=>{
 const env=await oauthEnv(1),original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,o)=>{calls++;assert.equal(url,'https://www.kaggle.com/api/v1/oauth2/token');assert.equal(o.redirect,'manual');assert.equal(o.body.get('grant_type'),'refresh_token');assert.equal(o.body.get('client_id'),'studio-public-test');return Response.json({access_token:'new-private-test',refresh_token:'rotated-private-test',expires_in:10800,token_type:'Bearer'})};
 try{const result=await Promise.all([kaggleAccessToken(env),kaggleAccessToken(env)]);assert.deepEqual(result,['new-private-test','new-private-test']);assert.equal(calls,1);
  const row=env.DB.raw.prepare('SELECT * FROM provider_credentials').get();assert.equal(row.revision,2);assert(!row.sealed.includes('rotated-private-test'));assert.equal((await decryptCredential(env,row)).refreshToken,'rotated-private-test');assert.equal(await kaggleAccessToken(env),'new-private-test');assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
test('ambiguous token exchange is not replayed, and invalid encryption has no secret-bearing error',async()=>{
 const env=await oauthEnv(1),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('network response lost: refresh-private-test')};
 try{for(let i=0;i<2;i++)await assert.rejects(kaggleAccessToken(env),e=>e.status===503&&!e.message.includes('refresh-private-test'));assert.equal(calls,1);assert.equal(env.DB.raw.prepare('SELECT refresh_state FROM provider_credentials').get().refresh_state,'inflight');
  await assert.rejects(kaggleAccessToken({...env,STUDIO_INSTALLATION_ID:'other-installation'}),/sign-in again/);
 }finally{globalThis.fetch=original;}
});
test('original manually configured Kaggle token retains precedence and does not touch OAuth storage',async()=>{
 assert.equal(await kaggleAccessToken({KAGGLE_API_TOKEN:'manual-original-fixture'}),'manual-original-fixture');
 const env=await oauthEnv(Date.now()/1000+10000);assert.equal(await kaggleAccessToken(env),'expired-private-test');
});
