const TERMINAL=new Set(['COMPLETE','ERROR','CANCEL_ACKNOWLEDGED','CANCELLED','CANCELED','MANUALLY_CONFIRMED']);
const seconds=value=>{
 if(typeof value==='number')return Number.isFinite(value)&&value>0?value:null;
 if(typeof value!=='string'||!value.trim())return null;
 const result=/^\d+(?:\.\d+)?$/.test(value)?Number(value):Date.parse(value)/1000;
 return Number.isFinite(result)&&result>0?result:null;
};
const duration=value=>value===null?'—':Math.floor(value/60)+' min';
export function sessionState(manager,now=Date.now()/1000){
 const run=manager?.run,started=seconds(run?.started),ended=seconds(run?.ended),heartbeat=seconds(run?.heartbeat);
 const terminal=TERMINAL.has(run?.kaggle_state);
 const released=!!run&&(!!ended||!run.active||terminal);
 const active=!!run&&!released;
 const fresh=heartbeat!==null&&now-heartbeat>=-30&&now-heartbeat<=65;
 const runtimeStopped=['stopped','error','ended'].includes(run?.service);
 const stopping=active&&(!!run.stop||run.kaggle_state==='CANCEL_REQUESTED');
 let elapsedSeconds=null,timing='unavailable';
 if(started!==null){
  if(ended!==null&&ended>=started&&!run.ended_estimate_only){elapsedSeconds=ended-started;timing='ended'}
  else if(heartbeat!==null&&(released||runtimeStopped||!fresh)&&heartbeat>=started){elapsedSeconds=heartbeat-started;timing='last_reported'}
  else if(active&&!released&&!runtimeStopped&&fresh){elapsedSeconds=Math.max(0,now-started);timing='running'}
 }
 const unreachable=manager?.endpoint?.reachable===false||run?.endpoint_reachable===false;
 const status=unreachable&&active?'Model endpoint unreachable':!run?'No active session':released?(run.kaggle_state==='ERROR'?'ERROR':run.kaggle_state==='COMPLETE'?'COMPLETE':'Session ended'):
  stopping?'Stop requested':runtimeStopped?'Runtime stopped; awaiting Kaggle':started&&!fresh?'Heartbeat delayed':run.service||run.kaggle_state||'Unknown';
 const remaining=active&&!stopping&&!runtimeStopped&&fresh&&typeof run?.remaining_seconds_estimate==='number'?Math.max(0,Math.ceil(run.remaining_seconds_estimate/60))+' min':'—';
 return {active,ready:active&&!unreachable&&!stopping&&!runtimeStopped&&fresh&&run?.service==='ready',status,remaining,elapsedSeconds,elapsed:duration(elapsedSeconds),timing,
  elapsedLabel:timing==='last_reported'?'Last reported runtime':released?'Last session duration':'Session elapsed',
  timingNote:timing==='last_reported'?'The actual end time is unavailable. Showing the last reported runtime; it may be incomplete.':'Estimated from the runtime start and recorded end. This is not Kaggle GPU quota usage.'};
}

export function shouldRefreshKaggle(manager){const r=manager?.run;return !!(r?.active&&!r.ended&&(r.stop||['stopped','error','ended'].includes(r.service)||(r.started&&r.stale)));}
