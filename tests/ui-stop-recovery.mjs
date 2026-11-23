import {Window} from 'happy-dom';
import React,{act} from 'react';
import assert from 'node:assert/strict';
const w=new Window({url:'https://appassets.androidplatform.net/'});for(const k of ['window','document','navigator','HTMLElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])if(w[k])Object.defineProperty(globalThis,k,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?w[k].bind(w):w[k],configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const managerKey='private-manager-fixture-keep',modelKey='private-model-fixture-keep';
localStorage.setItem('studio-preferences',JSON.stringify({connectionSchema:2,language:'en',managerUrl:'https://manager.example.com',modelUrl:'https://manager.example.com/v1'}));sessionStorage.setItem('studio-keys',JSON.stringify({managerKey,modelKey}));
let run={id:'stuck-run',active:1,version:'7',started:1000,heartbeat:1120,stop:1,stale:true,service:'stopped'},manualCalls=0;
globalThis.fetch=async(url,o={})=>{url=String(url);
 if(url.endsWith('/healthz'))return Response.json({ok:true,build:'0.2.0-preview.2'});
 if(url.endsWith('/api/status'))return Response.json({run,config:{kernel_ref:'tester/studio-old',model_alias:'qwen'}});
 if(url.endsWith('/api/refresh')||url.endsWith('/api/models'))return Response.json({error:"GetKernel: HTTP 403. Permission 'kernels.get' was denied"},{status:502});
 if(url.endsWith('/api/quota'))return Response.json({available:false});
 if(url.endsWith('/api/diagnostics'))return Response.json({build:'0.2.0-preview.2',kernel_ref:'tester/studio-old',checks:[{check:'GetKernelSessionStatus',ok:false,error:'Denied '+managerKey+' Bearer '+modelKey}]});
 if(url.endsWith('/api/manual-ended')){manualCalls++;const b=JSON.parse(o.body);assert.equal(b.run_id,run.id);assert.equal(b.confirm,'I_STOPPED_IN_KAGGLE');run={...run,active:0,ended:1120,kaggle_state:'MANUALLY_CONFIRMED',service:'ended'};return Response.json({run})}
 throw Error('Unexpected request '+url);
};
const {createRoot}=await import('react-dom/client'),{default:App}=await import('../test-build/app-test.mjs'),root=createRoot(document.body.appendChild(document.createElement('div')));
await act(async()=>{root.render(React.createElement(App));await new Promise(r=>setTimeout(r,20))});
const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
const click=async label=>{const b=button(label);assert(b&&!b.disabled,label);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,25))})};
await click('Open settings');await click('Compute');assert(document.body.textContent.includes('Cloud manager update has not taken effect'));assert(!document.querySelector('.manager-version'));await click('Refresh Kaggle state');assert.equal(document.querySelector('.status-tag').textContent.trim(),'Status unconfirmed');assert(button('Start session').disabled);
await click('Check connection diagnostics');const report=document.querySelector('.diagnostic-details pre').textContent;assert(!report.includes('0.2.0-preview.2'));assert(report.includes('GetKernelSessionStatus'));assert(!report.includes(managerKey));assert(!report.includes(modelKey));
await click('I already stopped it on Kaggle');assert(button('Confirm ended and refresh').disabled);assert.equal(manualCalls,0);
await act(async()=>document.querySelector('.confirmation-check input').click());
// A concurrent new run must not be released by a stale confirmation.
const prior={...run};run={...run,id:'new-run'};await click('Confirm ended and refresh');assert.equal(manualCalls,0);assert(document.body.textContent.includes('The run changed'));run=prior;
await click('Confirm ended and refresh');assert.equal(manualCalls,1);assert(!button('Start session').disabled);assert.equal(document.querySelector('.status-tag').textContent.trim(),'Session ended');assert.equal(document.querySelector('.metrics strong').textContent,'2 min');
await act(async()=>root.unmount());await w.happyDOM.close();console.log('PASS: detected legacy manager; failed status shown as unconfirmed; diagnostics redact keys; explicit confirmation guarded by run ID; released only the confirmed manager record.');
