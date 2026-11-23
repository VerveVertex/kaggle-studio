import {Window} from 'happy-dom';
import React,{act} from 'react';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {harness,auth,account} from './provider-fixture.mjs';
const require=createRequire(new URL('../android/web/package.json',import.meta.url));
await require('esbuild').build({entryPoints:[new URL('../android/web/src/setup/SetupWizard.jsx',import.meta.url).pathname],outfile:new URL('../test-build/recovery-wizard.mjs',import.meta.url).pathname,bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],jsx:'automatic',banner:{js:"import {createRequire as __req} from 'node:module';const require=__req(import.meta.url);"}});
const w=new Window({url:'https://appassets.androidplatform.net/'});
for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])if(w[k])Object.defineProperty(globalThis,k,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?w[k].bind(w):w[k],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client'),{default:Wizard}=await import('../test-build/recovery-wizard.mjs');
const config=JSON.parse(readFileSync(new URL('../android/web/src/setup/publisher.json',import.meta.url))),artifact=JSON.parse(readFileSync(new URL('../android/web/src/setup/artifact.json',import.meta.url))),token='KGAT_'+'t'.repeat(32);
for(const partial of [false,true]){
 const h=harness(),second='b'.repeat(32);let fail=true,callback='',vault={version:1,stage:0,cloudflare:auth,accounts:[{id:account,name:'First'},{id:second,name:'Second'}],selected:account},connected=false;
 globalThis.StudioNative={readSetup:()=>JSON.stringify(vault),saveSetup:raw=>{vault=JSON.parse(raw);return true},readKeys:()=>JSON.stringify({}),saveKeys:()=>true,beginOAuthCallback:state=>{callback=state;return JSON.stringify({redirect_uri:'http://localhost:8765/oauth/cloudflare'})},readOAuthCallback:()=>JSON.stringify({state:callback,status:'complete',code:'fixture'}),cancelOAuthCallback:()=>{}};w.open=()=>{};
 const transport=async(url,o={})=>{
  if(url==='https://dash.cloudflare.com/oauth2/token')return Response.json({access_token:auth.accessToken,token_type:'Bearer',expires_in:3600,scope:config.cloudflare.scopes.join(' ')});
  if(url.endsWith('/IntrospectToken'))return Response.json({active:true,username:'tester'});
  if(url==='https://api.cloudflare.com/client/v4/accounts')return Response.json({success:true,result:vault.accounts});
  if(fail&&(partial&&url.endsWith('/connectivity/directory/services')&&o.method==='POST'||!partial&&url.includes('/workers/scripts/')&&url.endsWith('/settings')))return Response.json({success:false,errors:[{code:10000,message:'Permission denied'}]},{status:403});
  return h.transport(url,o);
 };
 const root=createRoot(document.body.appendChild(document.createElement('div')));
 const render=async()=>act(async()=>root.render(React.createElement(Wizard,{required:true,config,artifact,transport,onConnected:()=>{connected=true}})));
 const click=async label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label&&!b.disabled);assert(button,'Enabled button '+label);await act(async()=>{button.click();await new Promise(r=>setTimeout(r,20))});for(let n=0;n<150&&window.__studioSetupBusy;n++)await act(async()=>{await new Promise(r=>setTimeout(r,10))})};
 const change=async(element,value)=>act(async()=>{const proto=element.tagName==='SELECT'?w.HTMLSelectElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new w.Event('input',{bubbles:true}));element.dispatchEvent(new w.Event('change',{bubbles:true}));});
 await render();await click('Continue');await change(document.querySelector('input[type=password]'),token);
 // Reopen the wizard as if Android recreated it: the draft comes only from the encrypted vault.
 await act(async()=>root.render(null));await render();assert.equal(document.querySelector('input[type=password]').value,token);
 await click('Verify Kaggle token');await click('Build my workspace');assert.equal(vault.stage,3);assert(document.querySelector('[role=alert]'));const id=vault.plan.id;
 await click('Back to account settings');assert.equal(vault.stage,0);assert(!connected);
 if(partial){assert.equal(vault.plan.id,id);assert(document.querySelector('select[aria-label="Cloudflare account"]').disabled);assert.equal(h.databases.size,1);assert.equal(h.tunnels.size,1)}
 else{assert.equal(vault.plan,null);await change(document.querySelector('select[aria-label="Cloudflare account"]'),second);assert.equal(vault.selected,second);assert.deepEqual(h.creates,{})}
 fail=false;await click('Sign in');await click('Check sign-in');await click('Continue');assert.equal(document.querySelector('input[type=password]').value,token);await click('Verify Kaggle token');
 if(partial){await click('Resume build');assert.equal(vault.plan.id,id);assert.equal(h.creates.database,1);assert.equal(h.creates.tunnel,1)}else await click('Build my workspace');
 assert.equal(vault.plan.step,11);assert(!connected,'Only Enter Studio can finish setup');assert(!JSON.stringify(localStorage).includes(token));
 await act(async()=>root.unmount());localStorage.clear();
}
await w.happyDOM.close();console.log('PASS: encrypted token draft survives remount/back; preflight denial can return and change account; partial deployment retains identity/resources and resumes without duplicate creation; home stays gated.');
