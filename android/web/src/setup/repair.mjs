import {validManifest} from './installer.mjs';
import {verifyInstallation} from './maintenance.mjs';
import {sha256} from './crypto.mjs';
export async function currentManifest(cf,account,managerUrl){
 let u;try{u=new URL(managerUrl)}catch{throw Error('Connect the existing manager before repairing it.')}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/'||!/\bstudio-[a-f0-9]{12}\.[a-z0-9-]+\.workers\.dev$/.test(u.hostname))throw Error('Repair supports only an installer-owned workers.dev manager.');
 const worker=u.hostname.split('.')[0],settings=await cf.get('/accounts/'+account+'/workers/scripts/'+worker+'/settings');let manifest;
 try{manifest=JSON.parse(settings.bindings?.find(b=>b.name==='STUDIO_MANIFEST'&&b.type==='plain_text')?.text)}catch{}
 if(!validManifest(manifest,account,manifest?.kaggle)||manifest.worker!==worker||u.origin!=='https://'+manifest.worker+'.'+manifest.subdomain+'.workers.dev')throw Error('Choose the Cloudflare account that owns this manager.');
 return manifest;
}
export async function repairInstallation({cf,manifest:m,artifact,managerKey,transport=fetch}){
 // Code repair must remain available when Kaggle itself is unreadable or still shutting down.
 // It never clears a run lock, submits a notebook, rotates a Secret or changes the model profile.
 const settings=await verifyInstallation(cf,m),origin='https://'+m.worker+'.'+m.subdomain+'.workers.dev';
 if(!managerKey||await sha256(artifact.template)!==artifact.sha256)throw Error('Manager credentials or bundled code could not be verified.');
 const r=await transport(origin+'/api/status',{headers:{Authorization:'Bearer '+managerKey},redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('The current device cannot read this manager. Reconnect the device first.');
 const status=await r.json(),cfg=status.config;
 if(!cfg||cfg.manager_url?.replace(/\/$/,'')!==origin||cfg.kernel_ref!==m.kaggle+'/'+m.worker||cfg.tunnel_mode!=='vpc')throw Error('The existing manager configuration did not match this installation.');
 const marker=JSON.stringify('__STUDIO_CONFIG_JSON__');if(artifact.template.split(marker).length!==2)throw Error('Invalid repair artifact.');
 // A code-only repair preserves the entire deployment configuration, including the human notebook title.
 const source=artifact.template.replace(marker,JSON.stringify(JSON.stringify(cfg)));
 const metadata={main_module:'worker.mjs',compatibility_date:'2026-11-20',keep_bindings:['secret_text'],bindings:settings.bindings.filter(b=>b.type!=='secret_text')};
 const form=new FormData();form.append('metadata',JSON.stringify(metadata));form.append('worker.mjs',new Blob([source],{type:'application/javascript+module'}),'worker.mjs');
 await cf.put('/accounts/'+m.account+'/workers/scripts/'+m.worker,form);
 const health=await transport(origin+'/healthz',{redirect:'manual',signal:AbortSignal.timeout(15000)});const data=await health.json();
 if(!health.ok||data.installation_id!==m.id||data.build!==artifact.version)throw Error('The deployed repair version is not confirmed yet. Retry repair verification.');
 return {build:data.build,manifest:m};
}
