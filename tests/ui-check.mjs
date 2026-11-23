import {Window} from 'happy-dom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {harness,auth,account} from './provider-fixture.mjs';
const require=createRequire(new URL('../android/web/package.json',import.meta.url));
await require('esbuild').build({entryPoints:[new URL('../android/web/src/setup/SetupWizard.jsx',import.meta.url).pathname],outfile:new URL('../test-build/wizard.mjs',import.meta.url).pathname,bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],jsx:'automatic',banner:{js:"import {createRequire as __req} from 'node:module';const require=__req(import.meta.url);"}});
const w=new Window({url:'https://appassets.androidplatform.net/'});
for(const k of ['window','document','navigator','HTMLElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])if(w[k])Object.defineProperty(globalThis,k,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?w[k].bind(w):w[k],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let vault={},keys={imageKey:'existing-independent-key'},state='',provider='',closed=false,connected=null,tokenCalls=0;
globalThis.StudioNative={readSetup:()=>JSON.stringify(vault),saveSetup:value=>{vault=JSON.parse(value);return true},readKeys:()=>JSON.stringify(keys),saveKeys:value=>{keys=JSON.parse(value);return true},beginOAuthCallback:(s,p)=>{state=s;provider=p;return JSON.stringify({redirect_uri:'http://localhost:8765/oauth/'+p})},readOAuthCallback:()=>JSON.stringify({state,status:'complete',code:'oauth-code-fixture'}),cancelOAuthCallback:()=>{}};
w.open=()=>{};
const {default:Wizard}=await import('../test-build/wizard.mjs');
const config={releaseEnabled:true,cloudflare:{clientId:'studio-test',redirectUri:'http://localhost:8765/oauth/cloudflare',scopes:['fixture.scope']},kaggle:{clientId:'studio-test',redirectUri:'http://localhost:8765/oauth/kaggle'}};
const h=harness();
const transport=async(url,o)=>{
 if(url==='https://dash.cloudflare.com/oauth2/token'){tokenCalls++;return Response.json({access_token:auth.accessToken,expires_in:3600,token_type:'Bearer',scope:'fixture.scope'});}
 if(url==='https://www.kaggle.com/api/v1/oauth2/token'){tokenCalls++;return Response.json({access_token:'kaggle-test',refresh_token:'kaggle-refresh-test',expires_in:3600,token_type:'Bearer'});}
 if(url==='https://www.kaggle.com/api/v1/oauth2/introspect')return Response.json({active:true,username:'tester'});
 if(url==='https://dash.cloudflare.com/oauth2/revoke')return new Response('');
 return h.transport(url,o);
};
const mount=async(language,override=config)=>{const root=createRoot(document.body.appendChild(document.createElement('div')));await act(async()=>root.render(React.createElement(Wizard,{language,config:override,transport,onClose:()=>{closed=true},onConnected:async data=>{assert.equal(keys.managerKey,data.manager_key,'keys must persist before discarding setup');assert(localStorage.getItem('studio-preferences').includes(data.manager_url));connected=data}})));return root};
const click=async label=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent.trim()===label||x.getAttribute('aria-label')===label)&&!x.disabled);assert(b,'Missing enabled button: '+label);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,40))})};
let root=await mount('zh-CN',{...config,releaseEnabled:false});
assert(document.body.textContent.includes('尚未开放登录'));assert.equal([...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='登录'&&!b.disabled).length,0);assert.equal(tokenCalls,0);
await act(async()=>root.unmount());document.body.innerHTML='';root=await mount('en');
await click('Sign in');assert.equal(provider,'cloudflare');await click('Check sign-in');assert(vault.cloudflare);assert(!localStorage.getItem('studio-preferences'));
await click('Continue');await click('Sign in');assert.equal(provider,'kaggle');await click('Check sign-in');assert.equal(vault.identity.username,'tester');
assert(!document.body.textContent.includes('phone verification have not been confirmed'));await click('Build my workspace');
assert.equal(vault.plan.step,11);assert(document.body.textContent.includes('Workspace ready'));assert.equal(connected,null);assert.equal(tokenCalls,2);assert(!localStorage.getItem('studio-preferences'));
assert(!document.body.textContent.includes(auth.accessToken));assert(!document.body.textContent.includes(vault.plan.device.manager));
await click('Enter Studio');assert(closed);assert(connected.manager_url.endsWith('.workers.dev'));assert.equal(keys.imageKey,'existing-independent-key');assert.deepEqual(vault,{});
assert(!localStorage.getItem('studio-preferences').includes(keys.managerKey));
await act(async()=>root.unmount());document.body.innerHTML='';
// Another device signs into the same accounts: automatic discovery and scoped connection, no rebuild.
vault={version:1,cloudflare:auth,kaggle:{accessToken:'kaggle-test',refreshToken:'kaggle-refresh-test',expires:Date.now()/1000+3600,clientId:'studio-test'},identity:{username:'tester',phoneVerification:'unknown'},accounts:[{id:account,name:'Test Account'}],selected:account,stage:2};
closed=false;connected=null;root=await mount('zh-CN');await act(async()=>{await new Promise(r=>setTimeout(r,70))});
await click('连接此设备');assert.equal(vault.plan.step,11);assert.equal(vault.plan.existing,true);assert.deepEqual(h.creates,{database:1,tunnel:1,vpc:1,worker:1});assert(document.body.textContent.includes('工作空间已就绪'));
await click('进入 Studio');assert(closed);assert.equal((await h.env.DB.prepare('SELECT count(*) AS n FROM studio_devices').first()).n,2);
await act(async()=>root.unmount());await w.happyDOM.close();console.log('UI passed: unreleased sign-in gated; both OAuth flows; account selection; build review; real installer execution; verification; explicit enter; secure device-key handoff; no token in DOM/preferences.');
