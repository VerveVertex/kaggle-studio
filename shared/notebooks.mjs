// Exact notebook ownership is checked against signed run records, never a similar title.
export function normalizeKernelRef(value){
 if(typeof value!=='string')return null;let path=value.trim();
 if(/^https?:\/\//i.test(path)){try{const u=new URL(path);if(u.protocol!=='https:'||!['www.kaggle.com','kaggle.com'].includes(u.hostname)||u.username||u.password||u.port)return null;path=u.pathname}catch{return null}}
 path=path.replace(/^\/code\//i,'').replace(/\/$/,'');return /^[\w-]+\/[\w-]+$/.test(path)?path.toLowerCase():null;
}
export function settingsFromSource(source){
 if(typeof source!=='string')return null;const lines=source.split(/\r?\n/),prefix='SETTINGS = json.loads(';
 if(lines[0]!=='import json'||!lines[1]?.startsWith(prefix)||!lines[1].endsWith(')'))return null;
 try{const s=JSON.parse(JSON.parse(lines[1].slice(prefix.length,-1)));return s&&typeof s==='object'&&!Array.isArray(s)?s:null}catch{return null}
}
export async function sha256(value){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('')}
export async function ownNotebookRefs(rpc,username){
 const refs=new Set();for(let page=1;page<=20;page++){
  const b=await rpc('ListKernels',{group:'PROFILE',page,pageSize:100});if(b.kernels!==undefined&&!Array.isArray(b.kernels))throw Error('Unexpected Kaggle notebook list.');
  const kernels=b.kernels||[];for(const k of kernels){const ref=normalizeKernelRef(k.ref);if(ref?.split('/')[0]===username)refs.add(ref)}
  if(kernels.length<100)return [...refs];
 }throw Error('Too many Kaggle notebooks to verify ownership.');
}
export async function matchesRun(notebook,run,{configuredRef,managerUrl}){
 const s=settingsFromSource(notebook?.blob?.source);
 return !!(s&&run&&s.run_id===run.id&&typeof s.run_token==='string'&&await sha256(s.run_token)===run.agent_hash&&normalizeKernelRef(s.kernel_ref)===configuredRef&&s.manager_url?.replace(/\/$/,'')===managerUrl.replace(/\/$/,''));
}
export async function findRunNotebook(rpc,{configuredRef,managerUrl,run}){
 const [userName,kernelSlug]=configuredRef.split('/');
 let current;try{current=await rpc('GetKernel',{userName,kernelSlug})}catch(e){if(![403,404].includes(e.http_status||e.status))throw e}
 if(current&&await matchesRun(current,run,{configuredRef,managerUrl}))return {ref:configuredRef,notebook:current};
 // Old preview titles could create a different Kaggle slug. Read-only recovery requires this run's secret hash.
 const refs=await ownNotebookRefs(rpc,userName);let match=null;
 for(const ref of refs.filter(v=>v!==configuredRef)){
  let candidate;try{candidate=await rpc('GetKernel',{userName,kernelSlug:ref.split('/')[1]})}catch(e){if([403,404].includes(e.http_status||e.status))continue;throw e}
  if(await matchesRun(candidate,run,{configuredRef,managerUrl})){if(match)throw Error('More than one notebook matched this run.');match={ref,notebook:candidate}}
 }
 if(!match)throw Object.assign(Error('Cannot verify this run’s Kaggle notebook. Check its URL and token permissions.'),{status:409});return match;
}

export async function findInstallationNotebook(rpc,{configuredRef,managerUrl,runs}){
 const username=configuredRef.split('/')[0],refs=await ownNotebookRefs(rpc,username);let found=null;
 for(const ref of refs){
  let notebook;try{notebook=await rpc('GetKernel',{userName:username,kernelSlug:ref.split('/')[1]})}catch(e){if([403,404].includes(e.http_status||e.status))continue;throw e}
  const settings=settingsFromSource(notebook?.blob?.source),run=runs.find(r=>r.id===settings?.run_id);
  if(!run||!await matchesRun(notebook,run,{configuredRef,managerUrl}))continue;
  if(notebook.metadata?.ref&&normalizeKernelRef(notebook.metadata.ref)!==ref)throw Object.assign(Error('Kaggle notebook metadata did not match its URL.'),{status:409});
  if(found)throw Object.assign(Error('Multiple notebooks belong to this deployment. Check the notebook references before starting; no new notebook was submitted.'),{status:409});
  found={ref,notebook};
 }
 if(!found)throw Object.assign(Error('Cannot verify the existing deployment notebook. Check Kaggle access before starting; no new notebook was submitted.'),{status:409});
 return found;
}
