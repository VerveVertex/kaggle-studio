import {Cloudflare} from './cloudflare.mjs';
import {validManifest} from './installer.mjs';
import {sha256} from './crypto.mjs';
import {ownNotebookRefs,matchesRun,normalizeKernelRef} from '../../../../shared/notebooks.mjs';
export const REMOVE_STEPS=['notebooks','worker','vpc','tunnel','database'];
const terminal=new Set(['COMPLETE','ERROR','CANCEL_ACKNOWLEDGED','CANCELLED','CANCELED']);
export async function kaggleRequest(token,operation,body,transport=fetch){
 if(!['ListKernels','GetKernel','GetKernelSessionStatus','DeleteKernel'].includes(operation))throw Error('Unsupported maintenance operation.');
 const r=await transport('https://api.kaggle.com/v1/kernels.KernelsApiService/'+operation,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
 const b=await r.json();if(!r.ok||b.error||b.code>=400)throw Object.assign(Error('Kaggle '+operation+' failed (HTTP '+r.status+').'),{http_status:r.status});return b;
}
export async function verifyInstallation(cf,m){
 if(!validManifest(m,m?.account,m?.kaggle))throw Error('Invalid installation identity.');
 const root='/accounts/'+m.account;
 const settings=await cf.get(root+'/workers/scripts/'+m.worker+'/settings');
 const bindings=settings.bindings||[];
 if(!bindings.some(b=>b.name==='STUDIO_MANIFEST'&&b.text===JSON.stringify(m))||!bindings.some(b=>b.name==='DB'&&b.type==='d1'&&b.id===m.database)||!bindings.some(b=>b.name==='MODEL_VPC'&&b.type==='vpc_service'&&b.service_id===m.vpc))throw Error('The Worker no longer belongs to this installation.');
 const rows=await cf.sql(m.account,m.database,'SELECT manifest FROM studio_installation WHERE id=?',[m.id]);
 if(rows.length!==1||rows[0].manifest!==JSON.stringify(m))throw Error('The database installation identity did not match.');
 const [db,tunnel,vpc]=await Promise.all([cf.get(root+'/d1/database/'+m.database),cf.get(root+'/cfd_tunnel/'+m.tunnel),cf.get(root+'/connectivity/directory/services/'+m.vpc)]);
 if(db.name!==m.worker||tunnel.name!==m.worker||tunnel.deleted_at||vpc.name!==m.worker||vpc.host?.network?.tunnel_id!==m.tunnel)throw Error('Cloud resource ownership did not match.');
 return settings;
}
export async function notebookInventory(cf,m,token,transport,deletedRuns=[]){
 const runs=await cf.sql(m.account,m.database,'SELECT * FROM runs ORDER BY requested DESC');
 const rpc=(op,b)=>kaggleRequest(token,op,b,transport),own=await ownNotebookRefs(rpc,m.kaggle),notebooks=[];
 const configuredRef=m.kaggle+'/'+m.worker,managerUrl='https://'+m.worker+'.'+m.subdomain+'.workers.dev';
 for(const ref of own){
  const current=await rpc('GetKernel',{userName:m.kaggle,kernelSlug:ref.split('/')[1]});let matching=null;
  for(const run of runs)if(await matchesRun(current,run,{configuredRef,managerUrl})){matching=run;break;}
  if(!matching){if(ref===configuredRef)throw Error('The Kaggle notebook source belongs to another project.');continue;}
  const version=Number(current.metadata?.currentVersionNumber);if(!Number.isSafeInteger(version)||version<1)throw Error('Cannot verify the notebook version.');
  const status=await rpc('GetKernelSessionStatus',{userName:m.kaggle,kernelSlug:ref.split('/')[1],versionLabel:'v'+version});
  const state=typeof status.status==='number'?['QUEUED','RUNNING','COMPLETE','ERROR','CANCEL_REQUESTED','CANCEL_ACKNOWLEDGED','NEW_SCRIPT'][status.status]:String(status.status||'UNKNOWN').toUpperCase();
  if(!terminal.has(state))throw Error('Stop the Kaggle session and wait for confirmed completion before changing or deleting this deployment.');
  notebooks.push({ref,version,run:matching.id});
 }
 if(runs.some(r=>r.active&&!deletedRuns.includes(r.id)&&!notebooks.some(n=>n.run===r.id)))throw Error('Cannot confirm the recorded session has ended. Check Kaggle first.');
 // Only independently verified terminal notebooks may release stale local locks.
 return {notebooks,runs};
}
export async function updateInstallation({cf,manifest:m,artifact,profile,token,transport=fetch}){
 const settings=await verifyInstallation(cf,m);await notebookInventory(cf,m,token,transport);
 if(!profile?.config||(!artifact.profiles.some(p=>p.id===profile.id)&&profile.id!=='custom-gguf-v1')||await sha256(artifact.template)!==artifact.sha256)throw Error('The bundled model template failed verification.');
 const origin='https://'+m.worker+'.'+m.subdomain+'.workers.dev';
 const cfg={...profile.config,manager_url:origin,kernel_ref:m.kaggle+'/'+m.worker,kernel_title:m.worker,tunnel_mode:'vpc',model_url:'https://studio-vpc.invalid'};
 const marker=JSON.stringify('__STUDIO_CONFIG_JSON__');if(artifact.template.split(marker).length!==2)throw Error('Invalid deployment template.');
 // Preserve original master/admin/model/tunnel secrets. Only the explicitly provided Kaggle token is replaced.
 const metadata={main_module:'worker.mjs',compatibility_date:'2026-11-20',keep_bindings:['secret_text'],bindings:[...settings.bindings.filter(b=>b.type!=='secret_text'),{name:'KAGGLE_API_TOKEN',type:'secret_text',text:token.accessToken}]};
 const form=new FormData();form.append('metadata',JSON.stringify(metadata));form.append('worker.mjs',new Blob([artifact.template.replace(marker,JSON.stringify(JSON.stringify(cfg)))],{type:'application/javascript+module'}),'worker.mjs');
 await cf.put('/accounts/'+m.account+'/workers/scripts/'+m.worker,form);
 // Explicit model/profile updates also apply the selected next-session context, replacing an older override.
 await cf.sql(m.account,m.database,'CREATE TABLE IF NOT EXISTS studio_options(name TEXT PRIMARY KEY,value TEXT NOT NULL)');
 await cf.sql(m.account,m.database,"INSERT INTO studio_options(name,value) VALUES ('context_size',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",[String(profile.config.context_size)]);
 await cf.sql(m.account,m.database,"INSERT INTO studio_options(name,value) VALUES ('selected_model',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",[profile.config.model_alias]);
 await cf.sql(m.account,m.database,"INSERT INTO studio_options(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",['context_size:'+profile.config.model_alias,String(profile.config.context_size)]);
 const r=await transport(origin+'/healthz',{redirect:'manual',signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.installation_id!==m.id||b.build!==artifact.version)throw Error('Update result is not confirmed yet. Retry verification.');
 return {manifest:m,build:b.build};
}
export function newRemoval(manifest){if(!validManifest(manifest,manifest?.account,manifest?.kaggle))throw Error('Invalid deployment.');return {version:1,manifest,step:0,verified:false,done:[],notebooks:[],pending:null};}
export class Removal{
 constructor(state,{cf,token,transport=fetch,persist}){this.state=structuredClone(state);this.cf=cf;this.token=token;this.transport=transport;this.persist=persist;if(!persist||!validManifest(state?.manifest,state?.manifest?.account,state?.manifest?.kaggle))throw Error('Invalid deletion record.');}
 async save(){if(await this.persist(structuredClone(this.state))!==true)throw Error('Deletion progress could not be saved.');}
 async advance(){
  const s=this.state,m=s.manifest,cf=this.cf,root='/accounts/'+m.account;await this.save();
  if(s.step>=REMOVE_STEPS.length)return;
  if(!s.verified){await verifyInstallation(cf,m);const inventory=await notebookInventory(cf,m,this.token,this.transport);s.notebooks=inventory.notebooks;s.verified=true;await this.save();}
  const stage=REMOVE_STEPS[s.step];
  if(stage==='notebooks'){
   // Verify source and current state again at confirmation, before deleting anything remotely.
   const inventory=await notebookInventory(cf,m,this.token,this.transport,s.notebooks.map(n=>n.run));
   for(const item of inventory.notebooks){
    if(s.done.includes(item.ref))continue;s.pending=item.ref;await this.save();
    await kaggleRequest(this.token,'DeleteKernel',{userName:m.kaggle,kernelSlug:item.ref.split('/')[1]},this.transport);
    // A successful HTTP response alone is insufficient: require the notebook to disappear from the complete own list.
    const own=await ownNotebookRefs((op,b)=>kaggleRequest(this.token,op,b,this.transport),m.kaggle);if(own.includes(item.ref))throw Error('Kaggle has not confirmed notebook deletion yet.');
    s.done.push(item.ref);s.pending=null;await this.save();
   }
  }else{
   const paths={worker:'/workers/scripts/'+m.worker,vpc:'/connectivity/directory/services/'+m.vpc,tunnel:'/cfd_tunnel/'+m.tunnel,database:'/d1/database/'+m.database};
   const read=stage==='worker'?paths.worker+'/settings':paths[stage];let current;
   try{current=await cf.get(root+read)}catch(e){if(e.status!==404)throw e;}
   if(current){
    if(stage==='worker'&&!current.bindings?.some(b=>b.name==='STUDIO_MANIFEST'&&b.text===JSON.stringify(m)))throw Error('Worker identity changed; deletion stopped.');
    if(stage!=='worker'&&current.name!==m.worker)throw Error('Resource identity changed; deletion stopped.');
    if(stage==='vpc'&&current.host?.network?.tunnel_id!==m.tunnel)throw Error('Private service binding changed; deletion stopped.');
    if(stage==='database'){const rows=await cf.sql(m.account,m.database,'SELECT manifest FROM studio_installation WHERE id=?',[m.id]);if(rows[0]?.manifest!==JSON.stringify(m))throw Error('Database identity changed; deletion stopped.');}
    if(stage==='tunnel'&&current.deleted_at){/* Cloudflare retains a soft-deleted tunnel record. */}
    else{ s.pending=stage;await this.save();await cf.request(root+paths[stage],{method:'DELETE'}); }
    let remaining;try{remaining=await cf.get(root+read)}catch(e){if(e.status!==404)throw e;}
    if(remaining&&!(stage==='tunnel'&&remaining.deleted_at))throw Error('Cloudflare has not confirmed resource deletion yet.');
   }
   s.done.push(stage);s.pending=null;
  }
  s.step++;await this.save();
 }
}
