import {bridge,jsonBridge} from './services.js';
export const taskId=()=>crypto.randomUUID().replaceAll('-','');
export const pause=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'))},timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})});
export async function cancelJob(settings,id,kind){return jsonBridge('job_cancel',settings.modelUrl,settings.modelKey,{}, {extra:{jobId:id,kind}})}
export async function runJob(settings,kind,payload,{signal,onText=()=>{},onStatus=()=>{},id=taskId()}={}){
 let text='',offset=0,created=false,failures=0;const extra={jobId:id,kind};
 try{
  // A stable ID allows safe reconciliation after a lost response; never start a replacement generation.
  try{await jsonBridge('job_create',settings.modelUrl,settings.modelKey,{...payload,request_id:id},{signal,extra});created=true}catch(e){if(signal?.aborted)throw e;try{await jsonBridge('job_status',settings.modelUrl,settings.modelKey,undefined,{signal,extra});created=true}catch{throw e}}
  while(true){let job;try{job=await jsonBridge('job_status',settings.modelUrl,settings.modelKey,undefined,{signal,extra:{...extra,offset}});failures=0}catch(e){if(signal?.aborted||[400,401,403,404].includes(e.status)||++failures>4||/no longer available|not ready|invalid.*key|credential/i.test(e.message))throw e;onStatus('Connection interrupted; reconnecting to the same task…');await pause(1500,signal);continue}if(typeof job.text==='string'&&job.offset>=offset){text+=job.text;offset=job.offset;if(settings.streaming)onText(text)}
   onStatus(kind==='chat'?(text?'Generating response':'Processing long input…'):('Generating '+kind+' · '+(job.progress||0)+'%'));
   if(['error','canceled'].includes(job.state))throw Object.assign(Error(job.error||'Generation canceled.'),{code:job.error_code});
   if(job.state==='complete'&&offset>=(job.total||0)){if(kind==='chat'){if(!text)throw Error('The model returned no text.');onText(text);return{text}}return await bridge('job_file',settings.modelUrl,settings.modelKey,undefined,{signal,extra})}
   await pause(offset<(job.total||0)?10:1500,signal);
  }
 }catch(e){if(signal?.aborted){cancelJob(settings,id,kind).catch(()=>{});}throw e}
}
export async function ensureManagedModel(settings,id,{signal,onStatus=()=>{},start=true,onSnapshot=()=>{}}={}){
 const snapshot=()=>jsonBridge('manager_status',settings.managerUrl,settings.managerKey,undefined,{signal});
 const initial=await snapshot();if(!initial.models?.some(m=>m.id===id))return initial;
 await jsonBridge('manager_select',settings.managerUrl,settings.managerKey,{model_id:id},{signal});
 let submitted=false,deadline=Date.now()+45*60*1000,lastOfficial=0;
 while(Date.now()<deadline){if(signal?.aborted)throw new DOMException('Aborted','AbortError');const state=await snapshot();onSnapshot(state);
  if(state.selected_model!==id)throw Error('Another device changed the selected model. Select it again before continuing.');
  const r=state.run;if(r?.active){if(!r.stop&&(state.endpoint?.reachable===false||r.endpoint_reachable===false))throw Object.assign(Error('The model endpoint is unreachable. Open Compute to check the running session before trying again.'),{code:'MODEL_TUNNEL_UNREACHABLE'});if(state.requires_runtime_restart)throw Error('The manager was updated, but this model session still uses the old runtime. Stop it in Compute and start a new session.');if(state.active_model===id&&r.service==='ready'&&!r.stop&&!r.stale)return state;
   if(r.service==='error'&&!r.stop)throw Error('The model runtime failed. Open Compute, check the notebook logs and restart the session.');
   onStatus(r.stop?'Stopping previous model; waiting for Kaggle confirmation…':'Loading selected model…');
   if(Date.now()-lastOfficial>15000){lastOfficial=Date.now();await jsonBridge('manager_refresh',settings.managerUrl,settings.managerKey,undefined,{signal});}
  }else{if(!start)return state;if(submitted)throw Error('The model session ended before it became ready. Check Compute.');await jsonBridge('manager_start',settings.managerUrl,settings.managerKey,undefined,{signal});submitted=true;onStatus('Starting selected model…');}
  await pause(2500,signal);
 }
 throw Error('Model preparation timed out. Check Compute before starting another session.');
}
