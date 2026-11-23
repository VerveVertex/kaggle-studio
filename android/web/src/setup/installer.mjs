import {randomHex,sha256,seal} from './crypto.mjs';
import {Cloudflare} from './cloudflare.mjs';
// Known signed preview templates with compatible resource/state protocols.
const COMPATIBLE_PREVIEWS=new Set(['fdaaaf98af583ab83cf9b171c44294ca1da9fc903e9e8687a2a2b22604adf9b2','add2e80a420ff755e44d1cc31d79c4379f0eebc6976f7b01b5dac21bc1d6f82d','d637a4506b699e70dd1c76e1464354e0a7102e638829d0791e32f08cd2f549d5','4dccd2bb00ea2b3dfa4b9de7555aa32c788ca06392684ef789ff81b356d0127f','4259e3ef546e7df600d61d819f709fdf8d2511ca461de2a672b26318cd33ad30','d37278cec74b235ff6d118d11f0eda8159aa731b2abf6c69c1395fc30d15de39','4e7786c3d9494172fb28b765ed4d9f0a2222a2c0843a5a347ac1d97d7dc9dc3d']);
export const STEPS=['preflight','subdomain','database','schema','tunnel','vpc','manifest','worker','publish','device','verify'];
export class UncertainMutation extends Error {constructor(stage){super('The result of '+stage+' is unconfirmed. Automatic resubmission is blocked. Keep this installation record and check the Cloudflare account.');this.stage=stage;}}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const validName=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{2,62}$/.test(v);
export function validManifest(m,account,username){
 return m?.protocol===1&&/^[a-f0-9]{64}$/.test(m.id)&&m.account===account&&m.kaggle===username&&
  uuid(m.database)&&uuid(m.tunnel)&&uuid(m.vpc)&&validName(m.worker)&&validName(m.subdomain)&&
  m.worker==='studio-'+m.id.slice(0,12)&&/^[a-f0-9]{64}$/.test(m.artifactHash||'');
}
export function publicProgress(s){return {id:s.id,step:s.step,total:STEPS.length,phase:STEPS[s.step]||'complete',complete:s.step===STEPS.length,
 worker:s.worker,managerUrl:s.subdomain?'https://'+s.worker+'.'+s.subdomain+'.workers.dev':'',uncertain:s.pending?.stage||null,existing:!!s.existing};}
export function createPlan({account,identity,profile,auth,kaggle}){
 if(!/^[a-f0-9]{32}$/.test(account||'')||!identity?.username||!/^\w[\w-]{0,79}$/.test(identity.username)||!profile?.id)throw Error('Select verified accounts and a model template first.');
 const id=randomHex();
 return {format:1,id,account,username:identity.username,profile,auth,kaggle,phoneVerification:identity.phoneVerification||'unknown',
 worker:'studio-'+id.slice(0,12),databaseName:'studio-'+id.slice(0,12),step:0,pending:null,receipts:{},
 secrets:{admin:randomHex(),model:randomHex(),kaggleKey:randomHex()},
 device:{id:crypto.randomUUID(),manager:'studio_admin_'+randomHex(),model:'studio_model_'+randomHex(),expires:Math.floor(Date.now()/1000)+90*86400}};
}
export async function discoverInstallations(cf,account,username){
 if(!/^[a-f0-9]{32}$/.test(account))throw Error('Invalid account.');
 const root='/accounts/'+account, scripts=await cf.all(root+'/workers/scripts');const found=[];
 for(const script of scripts.filter(s=>/^studio-[a-f0-9]{12}$/.test(s.id||''))){
  const settings=await cf.get(root+'/workers/scripts/'+script.id+'/settings');
  const raw=settings.bindings?.find(b=>b.name==='STUDIO_MANIFEST'&&b.type==='plain_text')?.text;
  let m;try{m=JSON.parse(raw)}catch{continue}
  if(!validManifest(m,account,username)||m.worker!==script.id)continue;
  const bindings=settings.bindings||[];
  if(!bindings.some(b=>b.name==='DB'&&b.type==='d1'&&b.id===m.database)||!bindings.some(b=>b.name==='MODEL_VPC'&&b.type==='vpc_service'&&b.service_id===m.vpc))continue;
  const rows=await cf.sql(account,m.database,'SELECT manifest FROM studio_installation WHERE id=?',[m.id]);
  if(rows.length===1&&rows[0].manifest===raw)found.push(m);
 }
 return found;
}
export function importPlan(options,manifest){
 if(!validManifest(manifest,options.account,options.identity.username))throw Error('The installation belongs to different accounts or is incompatible.');
 const s=createPlan(options);return {...s,id:manifest.id,worker:manifest.worker,subdomain:manifest.subdomain,manifest,
  receipts:{database:manifest.database,tunnel:manifest.tunnel,vpc:manifest.vpc},existing:true,step:9,secrets:{}};
}
let active=false;
export class Installer{
 constructor(state,{transport=fetch,persist,artifact,verify=transport,cf}={}){
  if(state?.format!==1||!Number.isInteger(state.step)||state.step<0||state.step>STEPS.length||!persist||!artifact)throw Error('Invalid installation state.');
  this.state=structuredClone(state);this.persist=persist;this.artifact=artifact;this.transport=transport;this.verify=verify;this.cf=cf||new Cloudflare(state.auth,transport);
  this.root='/accounts/'+state.account;
 }
 async save(){if(await this.persist(structuredClone(this.state))!==true)throw Error('Installation progress could not be saved securely. No new operation was started.');}
 async once(stage,operation,validate=()=>true){
  const s=this.state;
  if(s.pending){
   if(s.pending.stage!==stage)throw new UncertainMutation(s.pending.stage);
   // Worker upload is reconciled by an exact manifest, not its name.
   if(stage==='worker'){
    try{const settings=await this.cf.get(this.root+'/workers/scripts/'+s.worker+'/settings');
     if(settings.bindings?.some(b=>b.name==='STUDIO_MANIFEST'&&b.text===JSON.stringify(s.manifest))){s.pending=null;await this.save();return true;}
    }catch{}
   }
   throw new UncertainMutation(stage);
  }
  s.pending={stage};await this.save();
  try{const result=await operation();if(!validate(result))throw new UncertainMutation(stage);s.pending=null;return result;}
  catch(e){if(e.definitive){s.pending=null;await this.save();}throw e;}
 }
 async advance(){
  if(active)throw Error('An installation operation is already in progress.');active=true;
  try{await this.save();const s=this.state,cf=this.cf,root=this.root,stage=STEPS[s.step];if(!stage)return publicProgress(s);
   if(s.artifactHash && s.artifactHash!==this.artifact.sha256){
    // Before uploading a Worker, compatible previews may resume the same receipts with corrected code.
    // Uncertain writes and already-uploaded workers require their original reconciliation flow.
    if(!s.existing&&!s.pending&&s.step<=7&&COMPATIBLE_PREVIEWS.has(s.artifactHash)&&this.artifact.protocol===1&&await sha256(this.artifact.template)===this.artifact.sha256){s.previousArtifactHash=s.artifactHash;s.artifactHash=this.artifact.sha256;await this.save();}
    else throw Error('Resume with the same installer version. The saved deployment artifact has changed.');
   }
   if(s.pending&&s.pending.stage!==stage)throw new UncertainMutation(s.pending.stage);
   switch(stage){
    case 'preflight':{
     if((await sha256(this.artifact.template))!==this.artifact.sha256)throw Error('The bundled deployment artifact failed integrity verification.');s.artifactHash=this.artifact.sha256;
     if(!(await cf.accounts()).some(a=>a.id===s.account))throw Error('Cloudflare access does not cover the selected account.');
     if(s.kaggle.kind!=='api_token'&&s.kaggle.expires<=Date.now()/1000+60)throw Error('Kaggle sign-in expired. Sign in again before installing.');
     const rpc=await this.transport('https://api.kaggle.com/v1/kernels.KernelsApiService/ListKernels',{method:'POST',headers:{Authorization:'Bearer '+s.kaggle.accessToken,'Content-Type':'application/json'},body:JSON.stringify({group:'PROFILE',page:1,pageSize:1}),redirect:'manual'});
     if(!rpc.ok)throw Error('Kaggle read access failed. Check account permissions and verification.');
     const list=await rpc.json();if(!list||typeof list!=='object'||Array.isArray(list)||list.error||list.code>=400||list.kernels!==undefined&&!Array.isArray(list.kernels))throw Error('Kaggle rejected the account check.');
     // A resource with a matching name is never treated as permission to overwrite it.
     try{await cf.get(root+'/workers/scripts/'+s.worker+'/settings');throw Error('This Worker name is already in use. No existing project was changed.');}catch(e){if(e.status!==404)throw e;}
     break;
    }
    case 'subdomain':{
     const result=await cf.get(root+'/workers/subdomain');
     if(result?.subdomain){s.subdomain=result.subdomain;s.pending=null;}
     else{
      const name='studio-'+s.account.slice(0,12);
      const created=await this.once(stage,()=>cf.put(root+'/workers/subdomain',{subdomain:name}),v=>validName(v?.subdomain));s.subdomain=created.subdomain;
     }
     if(!validName(s.subdomain))throw Error('Cloudflare returned an unsupported workers.dev subdomain.');break;
    }
    case 'database':{
     const db=await this.once(stage,()=>cf.post(root+'/d1/database',{name:s.databaseName}),v=>uuid(v?.uuid));s.receipts.database=db.uuid;break;
    }
    case 'schema':{
     // Additive DDL is repeatable; there is no DROP or reset of user records.
     if(s.pending)throw new UncertainMutation(stage);
     await cf.sql(s.account,s.receipts.database,this.artifact.schema);break;
    }
    case 'tunnel':{
     const tunnel=await this.once(stage,()=>cf.post(root+'/cfd_tunnel',{name:s.worker,config_src:'cloudflare'}),v=>uuid(v?.id));s.receipts.tunnel=tunnel.id;
     if(typeof tunnel.token==='string')s.tunnelToken=tunnel.token;break;
    }
    case 'vpc':{
     const service=await this.once(stage,()=>cf.post(root+'/connectivity/directory/services',{name:s.worker,type:'http',host:{ipv4:'127.0.0.1',network:{tunnel_id:s.receipts.tunnel}},http_port:8080}),v=>uuid(v?.service_id));s.receipts.vpc=service.service_id;break;
    }
    case 'manifest':{
     s.manifest={protocol:1,id:s.id,account:s.account,kaggle:s.username,database:s.receipts.database,tunnel:s.receipts.tunnel,vpc:s.receipts.vpc,worker:s.worker,subdomain:s.subdomain,profile:s.profile.id,artifactHash:this.artifact.sha256};
     if(!validManifest(s.manifest,s.account,s.username))throw Error('The installation manifest failed validation.');
     const raw=JSON.stringify(s.manifest);
     await cf.sql(s.account,s.receipts.database,'INSERT INTO studio_installation(id,manifest) VALUES (?,?) ON CONFLICT(id) DO NOTHING',[s.id,raw]);
     const rows=await cf.sql(s.account,s.receipts.database,'SELECT manifest FROM studio_installation WHERE id=?',[s.id]);if(rows[0]?.manifest!==raw)throw Error('The database belongs to a different installation.');
     if(s.kaggle.kind!=='api_token'){
      const credentials=await seal(s.secrets.kaggleKey,JSON.stringify(s.kaggle),'kaggle:'+s.id);
      await cf.sql(s.account,s.receipts.database,"INSERT INTO provider_credentials(provider,sealed) VALUES ('kaggle',?) ON CONFLICT(provider) DO NOTHING",[credentials]);
     }break;
    }
    case 'worker':{
     if(!s.tunnelToken){const token=await cf.get(root+'/cfd_tunnel/'+s.receipts.tunnel+'/token');if(typeof token!=='string'||!token)throw Error('Cloudflare did not return tunnel credentials.');s.tunnelToken=token;await this.save();}
     const manager='https://'+s.worker+'.'+s.subdomain+'.workers.dev';
     const cfg={...s.profile.config,manager_url:manager,kernel_ref:s.username+'/studio-'+s.id.slice(0,12),kernel_title:s.worker,tunnel_mode:'vpc',model_url:'https://studio-vpc.invalid'};
     const marker=JSON.stringify('__STUDIO_CONFIG_JSON__');
     if(this.artifact.template.split(marker).length!==2)throw Error('The deployment template is not compatible.');
     const source=this.artifact.template.replace(marker,JSON.stringify(JSON.stringify(cfg)));
     const plain=(name,text)=>({name,type:'plain_text',text});const secret=(name,text)=>({name,type:'secret_text',text});
     const metadata={main_module:'worker.mjs',compatibility_date:'2026-11-20',bindings:[
      {name:'DB',type:'d1',id:s.receipts.database},{name:'MODEL_VPC',type:'vpc_service',service_id:s.receipts.vpc},
      plain('STUDIO_MANIFEST',JSON.stringify(s.manifest)),plain('STUDIO_INSTALLATION_ID',s.id),
      secret('ADMIN_TOKEN',s.secrets.admin),secret('MODEL_API_KEY',s.secrets.model),...(s.kaggle.kind==='api_token'?[secret('KAGGLE_API_TOKEN',s.kaggle.accessToken)]:[secret('KAGGLE_CREDENTIALS_KEY',s.secrets.kaggleKey)]),secret('CF_TUNNEL_TOKEN',s.tunnelToken)]};
     const form=new FormData();form.append('metadata',JSON.stringify(metadata));form.append('worker.mjs',new Blob([source],{type:'application/javascript+module'}),'worker.mjs');
     await this.once(stage,()=>cf.put(root+'/workers/scripts/'+s.worker,form));break;
    }
    case 'publish':{
     // Idempotent within this installation. Never rename an account subdomain.
     await cf.post(root+'/workers/scripts/'+s.worker+'/subdomain',{enabled:true,previews_enabled:false});break;
    }
    case 'device':{
     if(s.existing){
      const settings=await cf.get(root+'/workers/scripts/'+s.worker+'/settings');
      if(!settings.bindings?.some(b=>b.name==='STUDIO_MANIFEST'&&b.text===JSON.stringify(s.manifest)))throw Error('The existing project changed. Sign in again and recheck it.');
      const rows=await cf.sql(s.account,s.receipts.database,'SELECT manifest FROM studio_installation WHERE id=?',[s.id]);
      if(rows[0]?.manifest!==JSON.stringify(s.manifest))throw Error('The existing installation could not be verified.');
     }
     const managerHash=await sha256(s.device.manager),modelHash=await sha256(s.device.model);
     await cf.sql(s.account,s.receipts.database,'INSERT INTO studio_devices(id,manager_hash,model_hash,created,expires) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING',[s.device.id,managerHash,modelHash,Math.floor(Date.now()/1000),s.device.expires]);
     const rows=await cf.sql(s.account,s.receipts.database,'SELECT manager_hash,model_hash FROM studio_devices WHERE id=?',[s.device.id]);
     if(rows[0]?.manager_hash!==managerHash||rows[0]?.model_hash!==modelHash)throw Error('Device authorization could not be confirmed.');break;
    }
    case 'verify':{
     const origin='https://'+s.worker+'.'+s.subdomain+'.workers.dev';
     const health=await this.verify(origin+'/healthz',{redirect:'manual'});if(!health.ok)throw Error('The deployed manager is not reachable yet. Retry verification later.');
     const data=await health.json();if(data.ok!==true||data.installation_id!==s.id)throw Error('The manager identity did not match this installation.');
     const status=await this.verify(origin+'/api/status',{headers:{Authorization:'Bearer '+s.device.manager},redirect:'manual'});
     if(!status.ok)throw Error('The new device authorization did not pass the manager check.');
     const body=await status.json();if(body.config?.kernel_ref!==s.username+'/studio-'+s.id.slice(0,12)||body.base_url!==origin+'/v1')throw Error('The manager returned an incompatible configuration.');break;
    }
   }
   s.step++;await this.save();return publicProgress(s);
  }finally{active=false;}
 }
 connection(){const s=this.state;if(s.step!==STEPS.length)throw Error('The project is not ready.');const origin='https://'+s.worker+'.'+s.subdomain+'.workers.dev';return {status:'connected',manager_url:origin,model_url:origin+'/v1',manager_key:s.device.manager,model_key:s.device.model,expires_at:s.device.expires};}
}
