import {harness} from './provider-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {Cloudflare,CloudflareError} from '../android/web/src/setup/cloudflare.mjs';
import {Installer,createPlan,importPlan,discoverInstallations,publicProgress,UncertainMutation,STEPS} from '../android/web/src/setup/installer.mjs';
import {configuration,beginOAuth,exchangeOAuth,kaggleIdentity} from '../android/web/src/setup/oauth.mjs';
import {challenge,sha256} from '../android/web/src/setup/crypto.mjs';
const artifact=JSON.parse(readFileSync(new URL('../android/web/src/setup/artifact.json',import.meta.url)));
const account='a'.repeat(32),username='tester';
const auth={accessToken:'cf-test-only',expires:Date.now()/1000+3600,clientId:'test-public-studio'};
const kaggle={accessToken:'kaggle-test-only',refreshToken:'refresh-test-only',expires:Date.now()/1000+3600,clientId:'studio-test'};
const config={releaseEnabled:true,cloudflare:{clientId:'studio-public-test',scopes:['test.permission'],redirectUri:'http://localhost:8765/oauth/cloudflare'},kaggle:{clientId:'studio-public-test',redirectUri:'http://localhost:8765/oauth/kaggle'}};
const makePlan=()=>createPlan({account,identity:{username,phoneVerification:'unknown'},profile:artifact.profiles[0],auth,kaggle});

async function install(h,state=makePlan(),extra={}){
 let persisted;const engine=new Installer(state,{artifact,transport:h.transport,persist:async s=>{persisted=structuredClone(s);return true},...extra});
 while(engine.state.step<STEPS.length)await engine.advance();return {engine,persisted};
}
test('full no-domain installation deploys executable manager, preserves account subdomain and does not request a GPU',async()=>{
 const h=harness(),{engine}=await install(h),s=engine.state;assert.equal(s.subdomain,'existing-studio');assert.deepEqual(h.creates,{database:1,tunnel:1,vpc:1,worker:1});
 assert.equal(s.phoneVerification,'unknown');assert.equal(engine.connection().model_url,engine.connection().manager_url+'/v1');
 assert.equal(h.calls.some(([method,path])=>method==='PUT'&&path.endsWith('/workers/subdomain')),false);
 assert.equal((await h.env.DB.prepare('SELECT count(*) AS n FROM runs').first()).n,0);
 const row=await h.env.DB.prepare('SELECT sealed FROM provider_credentials').first();assert(!row.sealed.includes(kaggle.refreshToken));
 const settings=[...h.scripts.values()][0].metadata;assert(!JSON.stringify(settings.bindings.filter(b=>b.type!=='secret_text')).includes(s.secrets.admin));
 assert.equal(h.env.ADMIN_TOKEN,s.secrets.admin);assert.notEqual(s.device.manager,s.secrets.admin);
 assert(!JSON.stringify(publicProgress(s)).includes(s.device.manager));assert(!JSON.stringify(publicProgress(s)).includes(auth.accessToken));
});
test('first-time account gets workers.dev without a custom domain',async()=>{
 const h=harness();h.clearSubdomain();const {engine}=await install(h);assert.equal(engine.state.subdomain,'studio-'+account.slice(0,12));assert.equal(h.calls.filter(([m,p])=>m==='PUT'&&p.endsWith('/workers/subdomain')).length,1);
});
test('existing project is proven by bindings and D1 manifest, and a second device never changes original secrets',async()=>{
 const h=harness(),first=(await install(h)).engine,oldKeys={admin:h.env.ADMIN_TOKEN,model:h.env.MODEL_API_KEY};
 const manifests=await discoverInstallations(new Cloudflare(auth,h.transport),account,username);assert.equal(manifests.length,1);
 const plan=importPlan({account,identity:{username},profile:artifact.profiles[0],auth,kaggle},manifests[0]);
 const second=(await install(h,plan)).engine;assert.notEqual(second.state.device.manager,first.state.device.manager);
 assert.deepEqual(h.creates,{database:1,tunnel:1,vpc:1,worker:1});assert.equal(h.env.ADMIN_TOKEN,oldKeys.admin);assert.equal(h.env.MODEL_API_KEY,oldKeys.model);
 assert.equal((await h.env.DB.prepare('SELECT count(*) AS n FROM studio_devices').first()).n,2);
 assert.equal((await discoverInstallations(new Cloudflare(auth,h.transport),account,'another-user')).length,0);
});
test('an accepted create with a lost response is durably uncertain and cannot be blindly retried',async()=>{
 const h=harness();let saved,intercepted=false;const transport=async(url,options)=>{const response=await h.transport(url,options);if(!intercepted&&options.method==='POST'&&url.endsWith('/d1/database')){intercepted=true;throw Error('lost response')}return response};
 const engine=new Installer(makePlan(),{artifact,transport,persist:async s=>{saved=structuredClone(s);return true}});
 await engine.advance();await engine.advance();await assert.rejects(engine.advance());assert.equal(saved.pending.stage,'database');assert.equal(h.creates.database,1);
 const restored=new Installer(saved,{artifact,transport:h.transport,persist:async()=>true});await assert.rejects(restored.advance(),UncertainMutation);assert.equal(h.creates.database,1);
});
test('loss after Worker upload is reconciled by exact installation identity without replacing credentials again',async()=>{
 const h=harness();let saved;const engine=new Installer(makePlan(),{artifact,transport:async(url,o)=>{const response=await h.transport(url,o);if(o.method==='PUT'&&url.includes('/workers/scripts/'))throw Error('lost upload response');return response},persist:async s=>{saved=structuredClone(s);return true}});
 while(engine.state.step<7)await engine.advance();await assert.rejects(engine.advance());assert.equal(saved.pending.stage,'worker');
 const resumed=(await install(h,saved)).engine;assert.equal(h.creates.worker,1);assert.equal(resumed.state.step,STEPS.length);
});
test('secure storage failure happens before external mutations',async()=>{
 const h=harness(),engine=new Installer(makePlan(),{artifact,transport:h.transport,persist:async()=>false});await assert.rejects(engine.advance(),/saved securely/);assert.deepEqual(h.creates,{});
});
test('project discovery does not accept a Worker name or a tampered manifest as ownership',async()=>{
 const h=harness();await install(h);const [script]=h.scripts.values();const binding=script.metadata.bindings.find(b=>b.name==='STUDIO_MANIFEST');const m=JSON.parse(binding.text);m.database=crypto.randomUUID();binding.text=JSON.stringify(m);
 assert.equal((await discoverInstallations(new Cloudflare(auth,h.transport),account,username)).length,0);
});
test('application cannot enter before all verification steps, and a wrong manager identity does not pass verification',async()=>{
 const h=harness(),engine=new Installer(makePlan(),{artifact,transport:h.transport,verify:async()=>Response.json({ok:true,installation_id:'wrong'}),persist:async()=>true});assert.throws(()=>engine.connection(),/not ready/);
 while(engine.state.step<10)await engine.advance();await assert.rejects(engine.advance(),/identity did not match/);assert.equal(engine.state.step,10);
});
test('the installer rejects an already occupied Worker without a write',async()=>{
 const h=harness(),s=makePlan();h.scripts.set(s.worker,{metadata:{bindings:[]}});const engine=new Installer(s,{artifact,transport:h.transport,persist:async()=>true});await assert.rejects(engine.advance(),/already in use/);assert.deepEqual(h.creates,{});
});
test('cloud authorization failure does not expose provider response bodies or credentials',async()=>{
 const cf=new Cloudflare(auth,async()=>Response.json({success:false,errors:[{code:1234,message:auth.accessToken}]},{status:403}));
 await assert.rejects(cf.accounts(),e=>e instanceof CloudflareError&&e.definitive&&!e.message.includes(auth.accessToken));
});
test('OAuth uses RFC PKCE and Studio registrations, and is gated until real registration/testing',async()=>{
 assert.equal(await challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
 assert.throws(()=>configuration({...config,releaseEnabled:false}),/not released/);
 assert.throws(()=>configuration({...config,kaggle:{...config.kaggle,clientId:'kagglesdk'}}),/own public/);
 const native={beginOAuthCallback:(state,p)=>JSON.stringify({redirect_uri:config[p].redirectUri})};
 const session=await beginOAuth('kaggle',config,native),url=new URL(session.authorizeUrl);
 assert.equal(url.hostname,'www.kaggle.com');assert.equal(url.searchParams.get('state'),session.state);assert.equal(url.searchParams.get('code_challenge'),await challenge(session.verifier));assert.equal(url.searchParams.get('scope'),'resources.admin:*');assert.equal(url.searchParams.get('response_mode'),'query');
});
test('OAuth scope rejection and callback mismatch cannot authorize provisioning',async()=>{
 const native={beginOAuthCallback:(state,p)=>JSON.stringify({redirect_uri:config[p].redirectUri})};const session=await beginOAuth('cloudflare',config,native);
 native.readOAuthCallback=()=>JSON.stringify({status:'complete',state:'wrong',code:'private-test'});
 await assert.rejects(exchangeOAuth(session,config,()=>{throw Error('must not send')},native),/did not complete/);
 native.readOAuthCallback=()=>JSON.stringify({status:'complete',state:session.state,code:'private-test'});
 await assert.rejects(exchangeOAuth(session,config,async()=>Response.json({access_token:'test',token_type:'Bearer',expires_in:100,scope:'other.permission'}),native),/installation permissions/);
});
test('verified Kaggle login does not invent phone verification or GPU availability',async()=>{
 const identity=await kaggleIdentity(kaggle,async()=>Response.json({active:true,username:'Tester'}));assert.deepEqual(identity,{username:'tester',phoneVerification:'unknown'});
 await assert.rejects(kaggleIdentity(kaggle,async()=>Response.json({active:false,username:'tester'})),/verified account/);
});
test('clearing an unfinished setup revokes only its known device row, preserves runtime Kaggle grant and retains credentials on failure',async()=>{
 const {clearSetupCredentials}=await import('../android/web/src/setup/cleanup.mjs');
 const plan=makePlan();Object.assign(plan,{step:10,subdomain:'studio-test'});const initial={version:1,cloudflare:auth,kaggle,plan,pending:{state:'x'}};
 let current=structuredClone(initial),deletes=0,revokes=0,wipes=0;
 const native={readSetup:()=>JSON.stringify(current),saveSetup:raw=>{current=JSON.parse(raw);wipes++;return true},cancelOAuthCallback:()=>{}};
 await assert.rejects(clearSetupCredentials({native,removeDevice:async()=>{throw Error('offline')},transport:()=>{throw Error('must not revoke yet')}}),/offline/);assert.deepEqual(current,initial);assert.equal(wipes,0);
 await clearSetupCredentials({native,removeDevice:async s=>{deletes++;assert.equal(s.managerKey,plan.device.manager)},transport:async url=>{assert.equal(url,'https://dash.cloudflare.com/oauth2/revoke');revokes++;return new Response('')}});
 assert.equal(deletes,1);assert.equal(revokes,1);assert.equal(wipes,1);assert.deepEqual(current,{});
});
test('a different installer artifact cannot silently resume and replace an unfinished deployment',async()=>{
 const h=harness(),engine=new Installer(makePlan(),{artifact,transport:h.transport,persist:async()=>true});await engine.advance();
 const changed=new Installer(engine.state,{artifact:{...artifact,sha256:'0'.repeat(64)},transport:h.transport,persist:async()=>true});await assert.rejects(changed.advance(),/same installer version/);assert.deepEqual(h.creates,{});
});
test('manual Kaggle token mode does not need or invoke a Kaggle OAuth client',async()=>{
 const {personalKaggleToken}=await import('../android/web/src/setup/oauth.mjs');
 const raw={...config,releaseEnabled:false,testingEnabled:true,kaggle:{authMode:'api_token',clientId:''}};
 assert.equal(configuration(raw).kaggle.authMode,'api_token');
 await assert.rejects(beginOAuth('kaggle',raw,{beginOAuthCallback(){throw Error('must not run')}}),/token field/);
 const token=personalKaggleToken('  KGAT_'+'a'.repeat(32)+'  ');assert.equal(token.kind,'api_token');assert.equal(token.expires,null);
 for(const input of ['','legacy-key','Bearer KGAT_'+'a'.repeat(32),'KGAT_'+'x'.repeat(30)+'\nextra'])assert.throws(()=>personalKaggleToken(input),/KGAT_/);
});
test('personal token identity goes to the official SDK introspection RPC without URLs, refresh grants, or invented phone status',async()=>{
 const {personalKaggleToken}=await import('../android/web/src/setup/oauth.mjs');const token=personalKaggleToken('KGAT_'+'a'.repeat(32));
 let calls=0;const identity=await kaggleIdentity(token,async(url,options)=>{calls++;assert.equal(url,'https://api.kaggle.com/v1/security.OAuthService/IntrospectToken');assert.equal(options.headers.Authorization,'Bearer '+token.accessToken);assert.equal(options.redirect,'manual');assert.equal(JSON.parse(options.body).token,token.accessToken);return Response.json({active:true,username:'Tester'})});
 assert.equal(calls,1);assert.deepEqual(identity,{username:'tester',phoneVerification:'unknown'});
 await assert.rejects(kaggleIdentity(token,async()=>Response.json({active:true,username:'tester',exp:1})),/expired/);
 await assert.rejects(kaggleIdentity(token,async()=>Response.json({message:token.accessToken},{status:401})),e=>!e.message.includes(token.accessToken));
});
test('manual-token install places Kaggle token only in the user Worker Secret, not source, manifest or D1, and still verifies device authorization',async()=>{
 const {personalKaggleToken}=await import('../android/web/src/setup/oauth.mjs');const token=personalKaggleToken('KGAT_'+'c'.repeat(32));const plan=makePlan();plan.kaggle=token;
 const h=harness(),{engine}=await install(h,plan);
 assert.equal(h.env.KAGGLE_API_TOKEN,token.accessToken);assert.equal(h.env.KAGGLE_CREDENTIALS_KEY,undefined);
 assert.equal((await h.env.DB.prepare('SELECT count(*) AS n FROM provider_credentials').first()).n,0);
 const uploaded=[...h.scripts.values()][0];assert(!uploaded.source.includes(token.accessToken));assert(!JSON.stringify(engine.state.manifest).includes(token.accessToken));assert(!JSON.stringify(publicProgress(engine.state)).includes(token.accessToken));
 const masters={admin:h.env.ADMIN_TOKEN,model:h.env.MODEL_API_KEY,kaggle:h.env.KAGGLE_API_TOKEN};
 const manifests=await discoverInstallations(new Cloudflare(auth,h.transport),account,username);
 await install(h,importPlan({account,identity:{username},profile:artifact.profiles[0],auth,kaggle:token},manifests[0]));
 assert.equal(h.env.ADMIN_TOKEN,masters.admin);assert.equal(h.env.MODEL_API_KEY,masters.model);assert.equal(h.env.KAGGLE_API_TOKEN,masters.kaggle);assert.deepEqual(h.creates,{database:1,tunnel:1,vpc:1,worker:1});
});
test('rejected manual-token preflight creates no cloud resources',async()=>{
 const h=harness(),state=makePlan();state.kaggle={kind:'api_token',accessToken:'KGAT_'+'d'.repeat(32),expires:null};
 const engine=new Installer(state,{artifact,persist:async()=>true,transport:async(url,options)=>String(url).startsWith('https://api.kaggle.com/')?Response.json({error:'rejected'},{status:403}):h.transport(url,options)});
 await assert.rejects(engine.advance(),/Kaggle read access failed/);assert.deepEqual(h.creates,{});assert.equal(engine.state.step,0);
});

test('an old compatible pre-upload failure resumes the same resource receipts after APK update',async()=>{
 const h=harness(),engine=new Installer(makePlan(),{artifact,transport:h.transport,persist:async()=>true});
 while(engine.state.step<5)await engine.advance();
 const original=structuredClone(engine.state);original.artifactHash='d37278cec74b235ff6d118d11f0eda8159aa731b2abf6c69c1395fc30d15de39';
 const resumed=new Installer(original,{artifact,transport:h.transport,persist:async()=>true});while(resumed.state.step<11)await resumed.advance();
 assert.equal(resumed.state.id,original.id);assert.equal(resumed.state.receipts.database,original.receipts.database);assert.equal(resumed.state.receipts.tunnel,original.receipts.tunnel);assert.equal(h.creates.database,1);assert.equal(h.creates.tunnel,1);assert.equal(resumed.state.artifactHash,artifact.sha256);
 const uncertain={...original,pending:{stage:'vpc'}};await assert.rejects(new Installer(uncertain,{artifact,transport:h.transport,persist:async()=>true}).advance(),/same installer version/);
});

test('local Cloudflare expiry is definitive, sends no request and does not strand a pending create',async()=>{
 const {cloudflareExpired,CloudflareAuthorizationError}=await import('../android/web/src/setup/cloudflare.mjs');
 const {Cloudflare}=await import('../android/web/src/setup/cloudflare.mjs');
 assert(cloudflareExpired({accessToken:'old',expires:Date.now()/1000-1}));assert(cloudflareExpired({accessToken:'old',expires:NaN}));assert(!cloudflareExpired(auth));
 let requests=0;const cf=new Cloudflare({...auth,expires:1},async()=>{requests++;throw Error('network must not run')});
 await assert.rejects(cf.accounts(),e=>e instanceof CloudflareAuthorizationError&&e.definitive&&e.requiresAuthorization&&e.beforeRequest);
 const h=harness(),engine=new Installer(makePlan(),{artifact,transport:h.transport,persist:async()=>true});while(engine.state.step<2)await engine.advance();
 const expired=new Installer(engine.state,{artifact,transport:h.transport,cf,persist:async()=>true});await assert.rejects(expired.advance(),CloudflareAuthorizationError);assert.equal(expired.state.pending,null);assert.equal(requests,0);assert.equal(h.databases.size,0);
 const resumed=new Installer({...expired.state,auth},{artifact,transport:h.transport,persist:async()=>true});await resumed.advance();assert.equal(resumed.state.id,engine.state.id);assert.equal(h.creates.database,1);
});
