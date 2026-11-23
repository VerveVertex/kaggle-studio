import {jsonBridge} from './services.js';
export function managerOrigin(value){let u;try{u=new URL(value)}catch{throw Error('Enter your manager URL first.')}if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)throw Error('Use your manager root URL without /v1.');return u.origin;}
export function validatePairStart(base,data){
 const origin=managerOrigin(base);let u;try{u=new URL(data?.authorize_url)}catch{throw Error('The manager returned an invalid sign-in link.')}
 if(!/^[a-f0-9]{64}$/.test(data?.id||'')||u.origin!==origin||u.pathname!=='/connect/login'||u.username||u.password||u.hash||u.searchParams.get('id')!==data.id||data.confirmation_code!==data.id.slice(0,8).toUpperCase()||!Number.isFinite(data.expires_at))throw Error('The manager returned an invalid sign-in link.');
 return data;
}
export function validatePairResult(base,data){
 const origin=managerOrigin(base);
 if(data?.status!=='connected'||data.manager_url!==origin||data.model_url!==origin+'/v1'||!/^studio_admin_[a-f0-9]{64}$/.test(data.manager_key||'')||!/^studio_model_[a-f0-9]{64}$/.test(data.model_key||'')||!Number.isFinite(data.expires_at))throw Error('The manager returned invalid device credentials.');return data;
}
export async function beginConnection(base,language){
 const origin=managerOrigin(base),verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
 const challenge=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),x=>x.toString(16).padStart(2,'0')).join('');
 const data=validatePairStart(origin,await jsonBridge('cloudflare_begin',origin,'',{challenge,language}));
 return {...data,verifier,base:origin};
}
export async function finishConnection(session){
 const data=await jsonBridge('cloudflare_finish',session.base,'',{id:session.id,verifier:session.verifier});
 if(data?.status==='pending')return data;return validatePairResult(session.base,data);
}
