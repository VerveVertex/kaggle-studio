const encoder=new TextEncoder();
const inflight=new WeakMap();
const tokenError=()=>Object.assign(new Error('Kaggle authorization needs sign-in again; existing runs must be checked before restarting.'),{status:503,kind:'authorization'});
async function cryptKey(key,usage){
 if(!/^[a-f0-9]{64}$/.test(key||''))throw tokenError();
 return crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g),v=>parseInt(v,16)),{name:'AES-GCM'},false,[usage]);
}
export async function decryptCredential(env,row){
 try{const b=JSON.parse(row.sealed);if(b.v!==1)throw Error();
 const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(atob(b.iv),c=>c.charCodeAt(0)),additionalData:encoder.encode('kaggle:'+env.STUDIO_INSTALLATION_ID)},await cryptKey(env.KAGGLE_CREDENTIALS_KEY,'decrypt'),Uint8Array.from(atob(b.data),c=>c.charCodeAt(0)));
 return JSON.parse(new TextDecoder().decode(data));}catch{throw tokenError();}
}
async function encryptCredential(env,value){
 const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('kaggle:'+env.STUDIO_INSTALLATION_ID)},await cryptKey(env.KAGGLE_CREDENTIALS_KEY,'encrypt'),encoder.encode(JSON.stringify(value)));
 return JSON.stringify({v:1,iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...new Uint8Array(data)))});
}
async function acquire(env){
 const row=await env.DB.prepare("SELECT * FROM provider_credentials WHERE provider='kaggle'").first();
 if(!row)throw tokenError();const credentials=await decryptCredential(env,row);
 if(credentials.expires>Date.now()/1000+60&&credentials.accessToken)return credentials.accessToken;
 if(row.refresh_state!=='ready'||!credentials.refreshToken)throw tokenError();
 const claim=await env.DB.prepare("UPDATE provider_credentials SET refresh_state='inflight' WHERE provider='kaggle' AND revision=? AND refresh_state='ready' RETURNING provider").bind(row.revision).first();
 if(!claim)throw Object.assign(Error('Kaggle authorization is being refreshed. Retry this read later.'),{status:503});
 // Persist the intent before token exchange. A lost rotating-refresh response needs reauthorization, not a blind retry.
 try{
  const r=await fetch('https://www.kaggle.com/api/v1/oauth2/token',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,refresh_token:credentials.refreshToken}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw tokenError();const b=await r.json();
  if(typeof b.access_token!=='string'||String(b.token_type).toLowerCase()!=='bearer'||!(Number(b.expires_in)>0))throw tokenError();
  const next={...credentials,accessToken:b.access_token,refreshToken:b.refresh_token||credentials.refreshToken,expires:Date.now()/1000+Number(b.expires_in)};
  await env.DB.prepare("UPDATE provider_credentials SET sealed=?,revision=revision+1,refresh_state='ready' WHERE provider='kaggle' AND revision=? AND refresh_state='inflight'").bind(await encryptCredential(env,next),row.revision).run();
  return next.accessToken;
 }catch{throw tokenError();}
}
export async function kaggleAccessToken(env){
 if(env.KAGGLE_API_TOKEN)return env.KAGGLE_API_TOKEN;
 if(!env.KAGGLE_CREDENTIALS_KEY)throw tokenError();
 let promise=inflight.get(env.DB);if(!promise){promise=acquire(env).finally(()=>inflight.delete(env.DB));inflight.set(env.DB,promise)}return promise;
}
