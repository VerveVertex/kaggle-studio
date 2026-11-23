import {Window} from 'happy-dom';
import React,{act} from 'react';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {harness,auth,account} from './provider-fixture.mjs';
import {Installer,createPlan} from '../android/web/src/setup/installer.mjs';
const require=createRequire(new URL('../android/web/package.json',import.meta.url));
await require('esbuild').build({entryPoints:[new URL('../android/web/src/setup/SetupWizard.jsx',import.meta.url).pathname],outfile:new URL('../test-build/auth-expiry-wizard.mjs',import.meta.url).pathname,bundle:true,platform:'node',format:'esm',external:['react','react/*','react-dom','react-dom/*'],jsx:'automatic',banner:{js:"import {createRequire as __req} from 'node:module';const require=__req(import.meta.url);"}});
const w=new Window({url:'https://appassets.androidplatform.net/'});
for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','Element','Node','localStorage','sessionStorage','MutationObserver','ResizeObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])if(w[k])Object.defineProperty(globalThis,k,{value:['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(k)?w[k].bind(w):w[k],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createRoot}=await import('react-dom/client'),{default:Wizard}=await import('../test-build/auth-expiry-wizard.mjs');
const config=JSON.parse(readFileSync(new URL('../android/web/src/setup/publisher.json',import.meta.url))),artifact=JSON.parse(readFileSync(new URL('../android/web/src/setup/artifact.json',import.meta.url))),token='KGAT_'+'t'.repeat(32),second='b'.repeat(32);
for(const kind of ['new','existing','network','callback-failure']){
 const h=harness();let originalSecrets;
 if(kind==='existing'){
  const engine=new Installer(createPlan({account,identity:{username:'tester'},profile:artifact.profiles[0],auth,kaggle:{kind:'api_token',accessToken:token,expires:null}}),{transport:h.transport,artifact,persist:async()=>true});while(engine.state.step<11)await engine.advance();
  originalSecrets=Object.fromEntries(h.scripts.values().next().value.metadata.bindings.filter(b=>b.type==='secret_text').map(b=>[b.name,b.text]));
 }
 let vault={version:1,stage:2,cloudflare:kind==='network'?auth:{...auth,expires:1},selected:account,accounts:[{id:second,name:'Other Account'},{id:account,name:'Primary Account'}],identity:{username:'tester'},kaggle:{kind:'api_token',accessToken:token,expires:null},tokenDraft:token,profileId:'qwen38-27b-t4-256k-v1',contextSize:262144},callback='',exchanges=0,kaggleChecks=0,cancelled=0,failNetwork=kind==='network';
 globalThis.StudioNative={readSetup:()=>JSON.stringify(vault),saveSetup:raw=>{vault=JSON.parse(raw);return true},readKeys:()=>JSON.stringify({}),saveKeys:()=>true,beginOAuthCallback:state=>{callback=state;return JSON.stringify({redirect_uri:'http://localhost:8765/oauth/cloudflare'})},readOAuthCallback:()=>JSON.stringify({state:callback,status:'complete',code:'one-use'}),cancelOAuthCallback:()=>{cancelled++}};w.open=()=>{};
 const transport=async(url,o={})=>{
  if(url==='https://dash.cloudflare.com/oauth2/token'){exchanges++;if(kind==='callback-failure')return Response.json({error:'invalid_grant'},{status:400});return Response.json({access_token:auth.accessToken,token_type:'Bearer',expires_in:3600,scope:config.cloudflare.scopes.join(' ')})}
  if(url==='https://api.cloudflare.com/client/v4/accounts')return Response.json({success:true,result:vault.accounts});
  if(url==='https://dash.cloudflare.com/oauth2/revoke')return new Response('');
  if(url.endsWith('/IntrospectToken')){kaggleChecks++;return Response.json({active:true,username:'tester'})}
  if(failNetwork&&url.includes('/workers/scripts'))throw Error('network unavailable');
  return h.transport(url,o);
 };
 const root=createRoot(document.body.appendChild(document.createElement('div')));
 await act(async()=>{root.render(React.createElement(Wizard,{language:'zh-CN',required:true,config,artifact,transport,onConnected:()=>{throw Error('Must wait for Enter Studio')}}));await new Promise(r=>setTimeout(r,30))});
 const buttons=label=>[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()===label),click=async label=>{const b=buttons(label).find(b=>!b.disabled);assert(b,'Enabled '+label);await act(async()=>{b.click();await new Promise(r=>setTimeout(r,30))})};
 assert.equal(vault.stage,2);assert.equal(document.querySelector('[aria-label="上下文长度（Token）"]').value,'262144');
 assert(!document.body.textContent.includes('正在检查项目…'),'A failed check must not still claim to be loading');assert.equal(buttons('构建我的工作空间').length,0);
 if(kind==='network'){
  assert(document.body.textContent.includes('项目检查失败'));assert(!buttons('检查已有项目')[0].disabled);failNetwork=false;await click('检查已有项目');assert(buttons('构建我的工作空间').length);assert.equal(exchanges,0);
 }else{
  assert(document.body.textContent.includes('Cloudflare 授权已过期'));await click('重新授权 Cloudflare');await click('检查登录');
  if(kind==='callback-failure'){assert.equal(vault.pending,null);assert.equal(exchanges,1);assert(cancelled);assert(buttons('重新授权 Cloudflare').some(b=>!b.disabled));}
  else{
   assert.equal(vault.stage,2);assert.equal(vault.selected,account,'Reauthorization preserves the previously selected account when multiple accounts exist');assert.equal(vault.tokenDraft,token);assert.equal(vault.profileId,'qwen38-27b-t4-256k-v1');assert.equal(vault.contextSize,262144);assert.equal(kaggleChecks,0,'Kaggle token must not require re-entry or re-verification');assert.equal(exchanges,1);
   if(kind==='existing'){
    assert.equal(h.creates.worker,1,'Reauthorization only inspects; no deployment until the user clicks');await click('部署所选模型到此项目');assert.equal(vault.operationStep,2);assert.equal(vault.connection.model_id,'qwen3.8-27b');assert.equal(h.scripts.size,1);assert.equal(h.databases.size,1);assert.equal(h.tunnels.size,1);assert.equal(h.services.size,1);
    const secrets=Object.fromEntries(h.scripts.values().next().value.metadata.bindings.filter(b=>b.type==='secret_text').map(b=>[b.name,b.text]));for(const name of ['ADMIN_TOKEN','MODEL_API_KEY','CF_TUNNEL_TOKEN'])assert.equal(secrets[name],originalSecrets[name]);
   }else assert(buttons('构建我的工作空间').some(b=>!b.disabled));
  }
 }
 assert(!JSON.stringify(localStorage).includes(token));assert(!document.body.textContent.includes(token));await act(async()=>root.unmount());document.body.innerHTML='';localStorage.clear();
}
await w.happyDOM.close();console.log('PASS: expired model screen stops loading and reauthorizes in place; account/token/model/256K preserved; checked-empty account gets Build; existing project gets explicit model deployment without duplicated resources; network retry and failed one-use callbacks recover safely.');
