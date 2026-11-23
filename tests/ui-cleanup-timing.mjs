import {Window} from 'happy-dom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
const window=new Window({url:'https://appassets.androidplatform.net/'});
for(const key of ['window','document','navigator','HTMLElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']){
 if(window[key])Object.defineProperty(globalThis,key,{value:typeof window[key]==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?window[key].bind(window):window[key],configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const preferences={connectionSchema:2,language:'en',modelUrl:'https://model.example.com/v1',managerUrl:'https://gpu.example.com',modelId:'custom/model-id',theme:'light',streaming:true};
localStorage.setItem('studio-preferences',JSON.stringify(preferences));
sessionStorage.setItem('studio-keys',JSON.stringify({modelKey:'studio_model_'+'b'.repeat(64),managerKey:'studio_admin_'+'a'.repeat(64),imageKey:'independent-image-key',videoKey:'independent-video-key'}));

const originalKeys=JSON.parse(sessionStorage.getItem('studio-keys'));
const originalSecrets={ADMIN_TOKEN:'original-admin',MODEL_API_KEY:'original-model',KAGGLE_API_TOKEN:'original-kaggle',CF_TUNNEL_TOKEN:'original-tunnel'};
const originalSecretsCopy={...originalSecrets};
let deleteFails=true,deletes=0;
let backendRun={id:'last-run',active:0,started:1000,ended:1600,heartbeat:1600,stop:1,service:'ended',kaggle_state:'CANCEL_ACKNOWLEDGED',version:'3'};
globalThis.fetch=async(input,options={})=>{
 const url=String(input);
 if(url.endsWith('/api/status')||url.endsWith('/api/refresh'))return Response.json({run:backendRun,config:{kernel_ref:'owner/notebook'},base_url:preferences.managerUrl+'/v1'});
 if(url.endsWith('/api/models'))return Response.json({models:[],notebook:{ref:'owner/notebook'}});
 if(url.endsWith('/api/quota'))return Response.json({available:true,used_hours:0.2,reserved_hours:0,remaining_hours:29.8});
 if(url.endsWith('/connect/device/delete')){deletes++;assert.equal(options.headers.Authorization,'Bearer '+originalKeys.managerKey);return deleteFails?Response.json({error:'Deletion unavailable'},{status:503}):Response.json({ok:true,device_deleted:true,scope:'current_device'})}
 throw Error('Unexpected request: '+url);
};
const {default:App}=await import('../test-build/app-test.mjs');
const create=async()=>{const root=createRoot(document.body.appendChild(document.createElement('div')));await act(async()=>root.render(React.createElement(App)));return root};
const click=async label=>{const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label);assert(button,'Button missing: '+label);assert(!button.disabled,'Button disabled: '+label);await act(async()=>{button.click();await new Promise(r=>setTimeout(r,15))});};
let root=await create();await click('Open settings');await click('Connections');
const headings=[...document.querySelectorAll('.connection-section h3')].map(x=>x.textContent.trim());
assert.deepEqual(headings.slice(1),['GPU manager','Model services']);
await click('Connect manager');await click('Compute');
assert.equal(document.querySelector('.status-tag').textContent.trim(),'Session ended');
assert.equal(document.querySelector('.metrics strong').textContent,'10 min');
const actualNow=Date.now;Date.now=()=>actualNow()+3600*1000;
await click('Refresh Kaggle state');assert.equal(document.querySelector('.metrics strong').textContent,'10 min');
backendRun={id:'new-run',active:1,started:Date.now()/1000-120,heartbeat:Date.now()/1000,service:'ready',stop:0,version:'4',remaining_seconds_estimate:600};
await click('Refresh Kaggle state');assert.equal(document.querySelector('.metrics strong').textContent,'2 min');
assert.equal(document.querySelector('.status-tag').textContent.trim(),'ready');
Date.now=actualNow;
await click('Data');await click('Clear keys');assert(document.querySelector('[role="alert"]').textContent.includes('Saved keys were kept'));
assert.deepEqual(JSON.parse(sessionStorage.getItem('studio-keys')),originalKeys);
deleteFails=false;await click('Clear keys');
assert.deepEqual(JSON.parse(sessionStorage.getItem('studio-keys')),{modelKey:'',managerKey:'',imageKey:'',videoKey:''});
assert.equal(JSON.parse(localStorage.getItem('studio-preferences')).managerUrl,preferences.managerUrl);
assert.deepEqual(originalSecrets,originalSecretsCopy);
await act(async()=>root.unmount());
sessionStorage.setItem('studio-keys',JSON.stringify(originalKeys));
root=await create();await click('Open settings');await click('Data');
deleteFails=true;await click('Clear keys');assert.equal(JSON.parse(sessionStorage.getItem('studio-keys')).managerKey,originalKeys.managerKey);
deleteFails=false;await click('Clear keys');
const finalKeys=JSON.parse(sessionStorage.getItem('studio-keys'));assert.equal(finalKeys.modelKey,'');assert.equal(finalKeys.managerKey,'');assert.equal(finalKeys.imageKey,'');assert.equal(finalKeys.videoKey,'');
assert.equal(deletes,4);assert.deepEqual(originalSecrets,originalSecretsCopy);
await act(async()=>root.unmount());await window.happyDOM.close();
console.log('PASS: connection order; stopped duration froze after one hour; new run reset; both deletion actions retained keys on failure and cleared only after remote acknowledgement.');
