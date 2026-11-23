import {randomHex,challenge} from './crypto.mjs';
const PROVIDERS={
 cloudflare:{authorize:'https://dash.cloudflare.com/oauth2/auth',token:'https://dash.cloudflare.com/oauth2/token',revoke:'https://dash.cloudflare.com/oauth2/revoke'},
 kaggle:{authorize:'https://www.kaggle.com/api/v1/oauth2/authorize',token:'https://www.kaggle.com/api/v1/oauth2/token'}
};
// These are publisher-owned PUBLIC client IDs. No secret, personal domain or user account is bundled.
export function configuration(raw){
 if(!raw||raw.releaseEnabled!==true&&raw.testingEnabled!==true)throw Error('Automatic setup is not released yet. The publisher must finish provider registration and real-device validation.');
 if(!['oauth','api_token'].includes(raw.kaggle?.authMode||'oauth'))throw Error('Unsupported Kaggle authorization mode.');
 for(const provider of Object.keys(PROVIDERS)){
  if(provider==='kaggle'&&raw.kaggle.authMode==='api_token')continue;
  const c=raw[provider];let u;try{u=new URL(c?.redirectUri)}catch{}
  if(!c?.clientId||!u||u.protocol!=='http:'||u.hostname!=='localhost'||u.port!=='8765'||u.pathname!=='/oauth/'+provider||u.search||u.hash||u.username||u.password)throw Error('The publisher has not configured a registered OAuth client and callback.');
 }
 if(!Array.isArray(raw.cloudflare.scopes)||!raw.cloudflare.scopes.length||raw.cloudflare.scopes.some(s=>typeof s!=='string'||!/^[\w.*:-]+$/.test(s)))throw Error('Cloudflare installation scopes have not been verified.');
 if(raw.kaggle.authMode!=='api_token'&&(raw.kaggle.clientId==='kagglesdk'||raw.kaggle.clientId==='gemini-cli'||raw.kaggle.clientId.startsWith('org:')))throw Error('Studio requires its own public Kaggle OAuth client.');
 return raw;
}
export async function beginOAuth(provider,config,native=globalThis.StudioNative){
 configuration(config);const p=PROVIDERS[provider];if(!p)throw Error('Unknown sign-in provider.');if(provider==='kaggle'&&config.kaggle.authMode==='api_token')throw Error('Use the Kaggle API token field for this setup.');
 if(!native?.beginOAuthCallback)throw Error('Provider sign-in requires the Android app.');
 const verifier=randomHex(),state=randomHex(),redirectUri=config[provider].redirectUri;
 const result=JSON.parse(native.beginOAuthCallback(state,provider));
 if(result.redirect_uri!==redirectUri)throw Error('The registered callback is unavailable. Close another sign-in and retry.');
 const url=new URL(p.authorize);url.search=new URLSearchParams({...(provider==='kaggle'?{response_mode:'query'}:{}),client_id:config[provider].clientId,response_type:'code',redirect_uri:redirectUri,
  state,code_challenge:await challenge(verifier),code_challenge_method:'S256',
  scope:provider==='cloudflare'?config.cloudflare.scopes.join(' '):'resources.admin:*'});
 return {provider,state,verifier,redirectUri,authorizeUrl:url.href,created:Date.now()};
}
export async function exchangeOAuth(session,config,transport,native=globalThis.StudioNative){
 configuration(config);
 if(Date.now()-session.created>600000){native.cancelOAuthCallback(session.state);throw Error('Sign-in expired. Start again.');}
 const callback=JSON.parse(native.readOAuthCallback(session.state));
 if(callback.status==='pending')return null;
 if(callback.state!==session.state||callback.status!=='complete'||!callback.code)throw Error('Sign-in did not complete. Start again.');
 const response=await transport(PROVIDERS[session.provider].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'manual',
  body:new URLSearchParams({client_id:config[session.provider].clientId,grant_type:'authorization_code',code:callback.code,code_verifier:session.verifier,redirect_uri:session.redirectUri})});
 if(!response.ok)throw Error('The provider rejected sign-in. Check the registered client and callback.');
 const token=await response.json();
 if(typeof token.access_token!=='string'||!token.access_token||String(token.token_type).toLowerCase()!=='bearer'||!Number.isFinite(Number(token.expires_in))||Number(token.expires_in)<=0)throw Error('The provider returned an unsupported token.');
 if(session.provider==='kaggle'&&!token.refresh_token)throw Error('Kaggle did not grant continuing access. Sign in again.');
 if(session.provider==='cloudflare'&&config.cloudflare.scopes.some(s=>!String(token.scope||'').split(/\s+/).includes(s)))throw Error('Cloudflare did not grant the installation permissions.');
 return {accessToken:token.access_token,refreshToken:token.refresh_token||'',expires:Date.now()/1000+Number(token.expires_in),clientId:config[session.provider].clientId};
}
export async function kaggleIdentity(auth,transport){
 const personal=auth.kind==='api_token';
 const r=await transport(personal?'https://api.kaggle.com/v1/security.OAuthService/IntrospectToken':'https://www.kaggle.com/api/v1/oauth2/introspect',{method:'POST',redirect:'manual',headers:personal?{'Content-Type':'application/json',Authorization:'Bearer '+auth.accessToken}:{'Content-Type':'application/x-www-form-urlencoded'},body:personal?JSON.stringify({token:auth.accessToken}):new URLSearchParams({token:auth.accessToken}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('Kaggle could not verify this login.');const b=await r.json();
 if(b.active!==true||typeof b.username!=='string'||!/^\w[\w-]{0,79}$/.test(b.username))throw Error('Kaggle did not return a verified account identity.');
 // Token introspection is not evidence of phone verification or available GPUs.
 if(typeof b.exp==='number'&&b.exp<=Date.now()/1000)throw Error('This Kaggle token has expired. Generate a new token.');
 return {username:b.username.toLowerCase(),phoneVerification:'unknown'};
}
export async function revokeCloudflare(auth,transport){
 if(!auth?.accessToken)return;
 const r=await transport(PROVIDERS.cloudflare.revoke,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:auth.clientId,token:auth.accessToken,token_type_hint:'access_token'})});
 if(!r.ok)throw Error('Cloudflare authorization cleanup needs retry.');
 if(auth.refreshToken){const rr=await transport(PROVIDERS.cloudflare.revoke,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:auth.clientId,token:auth.refreshToken,token_type_hint:'refresh_token'})});if(!rr.ok)throw Error('Cloudflare authorization cleanup needs retry.');}
}

export function personalKaggleToken(value){
 const token=typeof value==='string'?value.trim():'';
 if(!/^KGAT_[A-Za-z0-9_.-]{20,4091}$/.test(token))throw Error('Paste a new Kaggle API token beginning with KGAT_.');
 return {kind:'api_token',accessToken:token,expires:null};
}
