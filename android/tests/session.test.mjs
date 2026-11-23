import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionState,shouldRefreshKaggle} from '../web/src/session.mjs';
const snapshot=fields=>({run:{id:'first',active:1,started:1000,heartbeat:1600,service:'ready',remaining_seconds_estimate:600,...fields}});
test('an ended session freezes at its recorded end instead of continuing from the first launch',()=>{
 const manager=snapshot({active:0,ended:1600,stop:1,kaggle_state:'CANCEL_ACKNOWLEDGED',service:'ended'});
 const first=sessionState(manager,4420),later=sessionState(manager,9000);
 assert.equal(first.elapsed,'10 min');assert.equal(later.elapsed,'10 min');assert.equal(first.elapsedSeconds,600);
 assert.equal(first.status,'Session ended');assert.equal(first.active,false);assert.equal(first.ready,false);assert.equal(first.remaining,'—');
});
test('a new runtime uses its own start timestamp; login and reconnect times do not affect duration',()=>{
 assert.equal(sessionState(snapshot({started:4000,heartbeat:4420}),4420).elapsed,'7 min');
 const manager={...snapshot({started:4000,heartbeat:4420}),connected_at:1};
 assert.equal(sessionState(manager,4420).elapsed,sessionState({...manager,connected_at:4400},4420).elapsed);
});
test('a stop request remains pending while the agent and Kaggle are active; it cannot become ready',()=>{
 const pending=sessionState(snapshot({stop:1,kaggle_state:'RUNNING'}),1630);
 assert(pending.active);assert(!pending.ready);assert.equal(pending.status,'Stop requested');assert.equal(pending.remaining,'—');
 for(const state of ['COMPLETE','ERROR','CANCEL_ACKNOWLEDGED','CANCELLED','CANCELED','MANUALLY_CONFIRMED']){
  const result=sessionState(snapshot({active:0,stop:1,ended:1600,kaggle_state:state}),9000);
  assert(!result.active);assert.notEqual(result.status,'Stop requested');assert.equal(result.elapsed,'10 min');
 }
});
test('missing completion time or a disconnected runtime shows only the last reported duration, which does not grow',()=>{
 for(const fields of [{active:0},{kaggle_state:'COMPLETE'},{service:'stopped'},{service:'error'},{}]){
  const manager=snapshot(fields),a=sessionState(manager,2000),b=sessionState(manager,5000);
  assert.equal(a.elapsed,'10 min');assert.equal(b.elapsed,'10 min');assert.equal(a.timing,'last_reported');
 }
 const stopped=sessionState(snapshot({service:'stopped'}),1610);assert(stopped.active);assert(!stopped.ready);
 assert.equal(stopped.status,'Runtime stopped; awaiting Kaggle');
});
test('unstarted or invalid timestamps never produce a wall-clock session duration',()=>{
 assert.equal(sessionState(null,5000).elapsed,'—');
 assert.equal(sessionState({run:{active:1,requested:1000,service:'submitted'}},5000).elapsed,'—');
 assert.equal(sessionState(snapshot({started:null,ended:1600}),5000).elapsed,'—');
 assert.equal(sessionState(snapshot({started:'bad',ended:1600}),5000).elapsed,'—');
 const iso=sessionState(snapshot({active:0,started:'2026-01-01T00:00:00Z',ended:'2026-01-01T00:12:00Z'}),Date.now()/1000);
 assert.equal(iso.elapsed,'12 min');
});

test('stop, stopped runtimes and stale heartbeats trigger official status checks, without resubmitting a GPU job',()=>{
 for(const fields of [{stop:1},{service:'stopped'},{service:'error'},{stale:true}])assert(shouldRefreshKaggle(snapshot({version:'3',...fields})));
 assert(!shouldRefreshKaggle(snapshot({version:'3'})));assert(shouldRefreshKaggle(snapshot({version:null,stop:1})));
 assert(!shouldRefreshKaggle(snapshot({version:'3',active:0,ended:1700,stop:1})));
});

test('late Kaggle confirmation cannot count the offline gap as GPU runtime',()=>{const result=sessionState(snapshot({active:0,ended:9000,heartbeat:1600,ended_estimate_only:true,service:'ended',kaggle_state:'COMPLETE'}),10000);assert.equal(result.elapsed,'10 min');assert.equal(result.timing,'last_reported');assert(!result.active)});
test('unreachable model endpoint vetoes ready while retaining the active-session lock',()=>{const now=Date.now()/1000,manager={endpoint:{reachable:false},run:{active:1,service:'ready',started:now-100,heartbeat:now}};const state=sessionState(manager,now);assert(state.active);assert.equal(state.ready,false);assert.equal(state.status,'Model endpoint unreachable')});
