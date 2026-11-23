import {Window} from 'happy-dom';
import React,{act} from 'react';
import assert from 'node:assert/strict';
const w=new Window({url:'https://appassets.androidplatform.net/'});
for(const k of ['window','document','navigator','HTMLElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])if(w[k])Object.defineProperty(globalThis,k,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?w[k].bind(w):w[k],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const intervals=new Map(),oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval;let serial=0;
globalThis.setInterval=(fn,ms)=>{const id=++serial;intervals.set(id,{fn,ms});return id};globalThis.clearInterval=id=>intervals.delete(id);
localStorage.setItem('studio-preferences',JSON.stringify({connectionSchema:2,language:'en',managerUrl:'https://manager.example.com',modelUrl:'https://manager.example.com/v1',modelId:'qwen'}));sessionStorage.setItem('studio-keys',JSON.stringify({managerKey:'fixture-key',modelKey:'fixture-model'}));
let run={id:'run',active:1,started:Date.now()/1000-120,heartbeat:Date.now()/1000,version:'1',service:'ready',stop:0},confirmed=false,refreshes=0,starts=0,hold=false,releaseHeld;
globalThis.fetch=async(input,o={})=>{const url=String(input);
 if(url.endsWith('/api/status')){const data={run:{...run},config:{model_alias:'qwen',kernel_ref:'tester/notebook'}};if(hold){hold=false;return new Promise(resolve=>{releaseHeld=()=>resolve(Response.json(data))})}return Response.json(data)}
 if(url.endsWith('/api/models'))return Response.json({error:'GetKernel: HTTP 403'},{status:502});
 if(url.endsWith('/api/quota'))return Response.json({available:false});
 if(url.endsWith('/api/stop')){run={...run,stop:1,service:'stopped'};return Response.json({run})}
 if(url.endsWith('/api/refresh')){refreshes++;if(confirmed)run={...run,active:0,ended:run.heartbeat,kaggle_state:'COMPLETE',service:'ended'};return Response.json({run})}
 if(url.endsWith('/api/start')){starts++;throw Error('Test must not start GPU work')}
 throw Error('Unexpected URL: '+url);
};
const {createRoot}=await import('react-dom/client'),{default:App}=await import('../test-build/app-test.mjs');const root=createRoot(document.body.appendChild(document.createElement('div')));
await act(async()=>{root.render(React.createElement(App));await new Promise(r=>setTimeout(r,30))});
const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
const click=async label=>{const b=button(label);assert(b&&!b.disabled,label);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,20))})};
await click('Open settings');await click('Compute');assert(button('Start session').disabled);hold=true;const ordinary=[...intervals.values()].find(x=>x.ms===5000);await act(async()=>{ordinary.fn();await new Promise(r=>setTimeout(r,10))});assert(releaseHeld);await click('Request stop');await act(async()=>{releaseHeld();await new Promise(r=>setTimeout(r,10))});assert(document.querySelector('.status-tag').textContent.includes('Stop requested'));assert(button('Start session').disabled);
const fast=[...intervals.values()].find(x=>x.ms===2000);assert(fast,'Stopping must enable 2-second polling');confirmed=true;
await act(async()=>{fast.fn();await new Promise(r=>setTimeout(r,30))});assert(!button('Start session').disabled);assert(button('Request stop').disabled);assert(document.querySelector('.status-tag').textContent.includes('COMPLETE'));assert.equal(starts,0);assert(refreshes>=1);assert.equal(document.querySelector('.metrics strong').textContent,'2 min');
await act(async()=>root.unmount());await w.happyDOM.close();globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear;
console.log('PASS: stop acknowledged immediately; 2-second official polling refreshed completion and re-enabled Start despite independent GetKernel 403; no GPU submission.');
