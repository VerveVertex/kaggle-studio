import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {harness,account,username,auth} from './provider-fixture.mjs';
import {createPlan,Installer} from '../android/web/src/setup/installer.mjs';
import {Cloudflare} from '../android/web/src/setup/cloudflare.mjs';
import {Removal,newRemoval,updateInstallation} from '../android/web/src/setup/maintenance.mjs';
import {repairInstallation,currentManifest} from '../android/web/src/setup/repair.mjs';
import {sha256} from '../shared/notebooks.mjs';
const artifact=JSON.parse(readFileSync(new URL('../android/web/src/setup/artifact.json',import.meta.url)));
const kaggle={kind:'api_token',accessToken:'KGAT_'+'fixture'.repeat(8),expires:null};
async function fixture({active=0,status='COMPLETE',legacy=false}={}){
 const h=harness();const p=createPlan({account,identity:{username},profile:artifact.profiles[0],auth,kaggle});
 const engine=new Installer(p,{transport:h.transport,artifact,persist:async()=>true});while(engine.state.step<11)await engine.advance();
 const m=engine.state.manifest,origin='https://'+m.worker+'.'+m.subdomain+'.workers.dev';const ref=username+'/'+(legacy?'studio-qwen-gguf-t4-2':m.worker),runToken='private-run-only';
 await h.env.DB.prepare('INSERT INTO runs(id,agent_hash,requested,active,version,service) VALUES (?,?,?,?,?,?)').bind('recorded-run',await sha256(runToken),Date.now()/1000,active,'1',status==='RUNNING'?'ready':'stopped').run();
 const source='import json\nSETTINGS = json.loads('+JSON.stringify(JSON.stringify({kernel_ref:username+'/'+m.worker,manager_url:origin,run_id:'recorded-run',run_token:runToken})) +')\n# runner';
 const notebooks=new Map([[ref,{metadata:{ref,currentVersionNumber:1},blob:{source}}],[username+'/managed-qwen-server',{metadata:{ref:username+'/managed-qwen-server',currentVersionNumber:3},blob:{source:'print("original")'}}]]);
 const deletes=[];let lost='';
 const transport=async(url,o={})=>{
  if(url.startsWith('https://api.kaggle.com/')){const op=url.split('/').at(-1),b=JSON.parse(o.body);
   if(op==='ListKernels')return Response.json({kernels:[...notebooks.keys()].map(ref=>({ref}))});
   const selected=b.userName+'/'+b.kernelSlug;
   if(op==='GetKernel')return notebooks.has(selected)?Response.json(notebooks.get(selected)):Response.json({error:{message:'Permission denied'}},{status:403});
   if(op==='GetKernelSessionStatus')return Response.json({status});
   if(op==='DeleteKernel'){deletes.push(selected);notebooks.delete(selected);if(lost==='notebooks'){lost='';throw Error('Lost response')}return Response.json({})}
   throw Error('Unexpected Kaggle operation '+op);
  }
  const r=await h.transport(url,o);if(o.method==='DELETE'&&lost==='worker'&&url.endsWith('/workers/scripts/'+m.worker)){lost='';throw Error('Lost response')}return r;
 };
 return {h,m,origin,ref,transport,cf:new Cloudflare(auth,transport),notebooks,deletes,lose:value=>{lost=value}};
}
test('updating an existing deployment preserves original master/tunnel keys and replaces only its Kaggle token',async()=>{
 const f=await fixture({legacy:true});const before={...f.h.env};
 await updateInstallation({cf:f.cf,manifest:f.m,artifact,profile:artifact.profiles[0],token:{...kaggle,accessToken:'KGAT_new_fixture'},transport:f.transport});
 const metadata=f.h.scripts.get(f.m.worker).metadata.bindings;const secret=name=>metadata.find(b=>b.name===name)?.text;
 for(const name of ['ADMIN_TOKEN','MODEL_API_KEY','CF_TUNNEL_TOKEN'])assert.equal(secret(name),before[name]);assert.equal(secret('KAGGLE_API_TOKEN'),'KGAT_new_fixture');
 assert.equal(f.h.databases.size,1);assert.equal(f.h.tunnels.size,1);assert.equal(f.h.services.size,1);assert.equal(f.h.creates.worker,2);assert.equal(f.deletes.length,0);
});
test('deletion covers only verified installation resources and its legacy-slug notebook',async()=>{
 const f=await fixture({legacy:true});let saved;const engine=new Removal(newRemoval(f.m),{cf:f.cf,token:kaggle,transport:f.transport,persist:async s=>{saved=s;return true}});
 while(engine.state.step<5)await engine.advance();assert.equal(saved.step,5);assert.deepEqual(f.deletes,[f.ref]);assert(f.notebooks.has(username+'/managed-qwen-server'));assert.equal(f.h.scripts.size,0);assert.equal(f.h.databases.size,0);assert.equal(f.h.services.size,0);assert(f.h.tunnels.get(f.m.tunnel).deleted_at);
 assert(!f.h.calls.some(([,url])=>url.includes('/oauth-clients/')||url.endsWith('/workers/subdomain')&&f.h.calls.some(([method,u])=>u===url&&method==='DELETE')));
});
test('a live GPU session blocks deletion before any provider mutation',async()=>{
 const f=await fixture({active:1,status:'RUNNING'});const engine=new Removal(newRemoval(f.m),{cf:f.cf,token:kaggle,transport:f.transport,persist:async()=>true});await assert.rejects(engine.advance(),/Stop the Kaggle session/);assert.equal(f.deletes.length,0);assert(!f.h.calls.some(([method])=>method==='DELETE'));
});
test('lost notebook or Worker deletion acknowledgements resume from durable receipts without deleting another project',async()=>{
 for(const stage of ['notebooks','worker']){const f=await fixture({active:1});let saved;const options={cf:f.cf,token:kaggle,transport:f.transport,persist:async s=>{saved=s;return true}};let engine=new Removal(newRemoval(f.m),options);f.lose(stage);
  await assert.rejects(async()=>{while(engine.state.step<5)await engine.advance()},/Lost response|HTTP 0/);
  assert(saved.verified);engine=new Removal(saved,options);while(engine.state.step<5)await engine.advance();assert.equal(engine.state.step,5);assert.deepEqual(f.deletes,[f.ref]);assert(f.notebooks.has(username+'/managed-qwen-server'));
 }
});
test('changed resource identity or a failed durable checkpoint prevents remote deletion',async()=>{
 const f=await fixture();f.h.tunnels.get(f.m.tunnel).name='original-tunnel';const engine=new Removal(newRemoval(f.m),{cf:f.cf,token:kaggle,transport:f.transport,persist:async()=>true});await assert.rejects(engine.advance(),/ownership/);assert.equal(f.deletes.length,0);
 const g=await fixture();const denied=new Removal(newRemoval(g.m),{cf:g.cf,token:kaggle,transport:g.transport,persist:async()=>false});await assert.rejects(denied.advance(),/saved/);assert.equal(g.deletes.length,0);assert(!g.h.calls.some(([method])=>method==='DELETE'));
});

test('code-only repair works despite unreadable Kaggle and an active lock, preserving every Secret and run',async()=>{
 const f=await fixture({active:1,status:'RUNNING',legacy:true}),beforeRun=await f.h.env.DB.prepare('SELECT * FROM runs').first();
 const before=structuredClone(f.h.scripts.get(f.m.worker).metadata.bindings);let kaggleCalls=0;
 const transport=async(url,o)=>{if(url.startsWith('https://api.kaggle.com/')){kaggleCalls++;return Response.json({error:{message:'kernels.get denied'}},{status:403})}return f.transport(url,o)};
 const beforeStatus=await (await f.transport(f.origin+'/api/status',{headers:{Authorization:'Bearer '+f.h.env.ADMIN_TOKEN}})).json();
 const legacyConfig={...beforeStatus.config,kernel_title:'Qwen GGUF4T×2',context_size:4096};
 const preservingTransport=async(url,o)=>url===f.origin+'/api/status'?Response.json({...beforeStatus,config:legacyConfig}):transport(url,o);
 const cf=new Cloudflare(auth,preservingTransport),m=await currentManifest(cf,account,f.origin);
 await repairInstallation({cf,manifest:m,artifact,managerKey:f.h.env.ADMIN_TOKEN,transport:preservingTransport});
 const repaired=await (await f.transport(f.origin+'/api/status',{headers:{Authorization:'Bearer '+f.h.env.ADMIN_TOKEN}})).json();assert.deepEqual(repaired.config,legacyConfig);
 assert.equal(kaggleCalls,0);assert.equal(f.h.creates.worker,2);assert.equal(f.h.databases.size,1);assert.equal(f.h.tunnels.size,1);assert.equal(f.h.services.size,1);
 assert.deepEqual(f.h.scripts.get(f.m.worker).metadata.bindings,before);assert.deepEqual(await f.h.env.DB.prepare('SELECT * FROM runs').first(),beforeRun);
 assert(!f.h.calls.some(([method])=>method==='DELETE'));
});
test('code-only repair cannot adopt another hostname or an unowned manifest',async()=>{
 const f=await fixture();await assert.rejects(currentManifest(f.cf,account,'https://kaggle-gpu-manager.example.com'),/installer-owned/);
 await assert.rejects(currentManifest(f.cf,'b'.repeat(32),f.origin),/Cloudflare account/);
 const before=f.h.creates.worker;await assert.rejects(repairInstallation({cf:f.cf,manifest:f.m,artifact,managerKey:'incorrect-device-key',transport:f.transport}),/current device/);assert.equal(f.h.creates.worker,before);
});

test('Qwen3.8 update preserves original resources and master keys while replacing an old context override with 256K',async()=>{
 const f=await fixture({legacy:true}),profile=artifact.profiles.find(p=>p.id==='qwen38-27b-t4-256k-v1');assert(profile);
 await f.h.env.DB.prepare("INSERT INTO studio_options(name,value) VALUES ('context_size','8192')").run();
 const before={...f.h.env};await updateInstallation({cf:f.cf,manifest:f.m,artifact,profile,token:kaggle,transport:f.transport});
 const status=await (await f.transport(f.origin+'/api/status',{headers:{Authorization:'Bearer '+before.ADMIN_TOKEN}})).json();
 assert.equal(status.config.model_alias,'qwen3.8-27b');assert.equal(status.config.context_size,262144);assert.equal(status.config.model_assets.weights.size,19403684480);assert.equal(status.config.kv_cache_type,'q4_0');
 for(const key of ['ADMIN_TOKEN','MODEL_API_KEY','CF_TUNNEL_TOKEN'])assert.equal(f.h.env[key],before[key]);assert.equal(f.h.databases.size,1);assert.equal(f.h.tunnels.size,1);assert.equal(f.h.services.size,1);assert.equal(f.deletes.length,0);
});
