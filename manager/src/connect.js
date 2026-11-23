// Cloudflare Authorization Code + S256 PKCE, followed by a browser confirmation.
// OAuth tokens and the Worker's original Secrets never leave this server.
const TTL=600, DEVICE_TTL=90*86400, SCOPE='workers-scripts.edit';
const AUTH='https://dash.cloudflare.com/oauth2/auth', TOKEN='https://dash.cloudflare.com/oauth2/token';
const COOKIE='__Host-studio-pair';
const now=()=>Date.now()/1000;
export const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
const base64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const issue=(status,message)=>{throw Object.assign(new Error(message),{status})};
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page(title,text,form='',language='en',status=200){
 const html=`<!doctype html><html lang="${language==='zh-CN'?'zh-CN':'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Kaggle Studio</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f7f7f7;color:#222;margin:0;padding:32px 20px}main{max-width:540px;margin:8vh auto;background:white;border:1px solid #ddd;border-radius:18px;padding:28px}h1{font-size:24px}code{font-size:26px;letter-spacing:4px}button{font:inherit;background:#222;color:white;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}p{overflow-wrap:anywhere}</style><main><small>Kaggle Studio</small><h1>${escape(title)}</h1><p>${escape(text)}</p>${form}</main></html>`;
 return new Response(html,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}
function originFor(cfg){
 let u;try{u=new URL(cfg.manager_url)}catch{issue(503,'The manager public URL is not configured.')}
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)issue(503,'The manager public URL is not configured.');
 return u.origin;
}
function configured(env){return typeof env.ADMIN_TOKEN==='string'&&env.ADMIN_TOKEN.length>=24&&typeof env.MODEL_API_KEY==='string'&&env.MODEL_API_KEY.length>=24&&env.ADMIN_TOKEN!==env.MODEL_API_KEY&&typeof env.CF_OAUTH_CLIENT_ID==='string'&&/^[\w.-]{8,200}$/.test(env.CF_OAUTH_CLIENT_ID)&&/^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID||'')&&/^[a-zA-Z0-9_-]{1,63}$/.test(env.CF_WORKER_NAME||'')}
function checkOrigin(req,origin,required=false){const value=req.headers.get('origin');if((required&&!value)||(value&&value!==origin))issue(403,'This browser request is not allowed.');}
async function boundedText(req,limit=4096){
 const reader=req.body?.getReader();if(!reader)issue(400,'Invalid connection request.');let text='',size=0;const decoder=new TextDecoder();
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();issue(413,'Connection request too large.')}text+=decoder.decode(value,{stream:true})}text+=decoder.decode();
 return text;
}
async function body(req){const text=await boundedText(req);try{return JSON.parse(text)}catch{issue(400,'Invalid connection request.')}}
async function getPair(env,id){if(!/^[a-f0-9]{64}$/.test(id||''))issue(400,'Invalid connection request.');const row=await env.DB.prepare('SELECT * FROM device_pairings WHERE id=?').bind(id).first();if(!row||row.expires<=now())issue(410,'Connection expired. Start again in the app.');return row;}
function cookie(req){return req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||''}
async function browserPair(req,env,id){const p=await getPair(env,id),c=cookie(req);if(!/^[a-f0-9]{64}$/.test(c)||!p.browser_hash||await sha(c)!==p.browser_hash)issue(403,'Return to the same browser used to sign in.');return p;}
function cookieHeader(value,maxAge=TTL){return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`}
function confirmation(p,origin){
 const zh=p.language==='zh-CN',code=p.id.slice(0,8).toUpperCase();
 const form=`<p><code>${code}</code></p><p>${escape(zh?'仅在你主动从 APK 发起绑定，且上方代码与 APK 显示一致时确认。这将允许此设备聊天及启动、停止当前管理端的 Kaggle 会话。设备密钥有效期为 90 天。':'Approve only if you initiated this request in the APK and the code matches. This gives that device chat access and control of this manager’s Kaggle session. Device keys expire after 90 days.')}</p><form method="post" action="${escape(origin)}/connect/approve"><input type="hidden" name="id" value="${p.id}"><button name="decision" value="approve">${zh?'确认绑定此设备':'Connect this device'}</button> <button name="decision" value="deny">${zh?'取消':'Cancel'}</button></form>`;
 return page(zh?'确认设备绑定':'Confirm device connection',zh?'Cloudflare 授权已验证，请对照 APK 中的确认代码。':'Cloudflare authorization verified. Compare this code with the APK.',form,p.language);
}
async function revoke(accessToken,clientId){try{await fetch('https://dash.cloudflare.com/oauth2/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:accessToken,token_type_hint:'access_token',client_id:clientId}),redirect:'manual',signal:AbortSignal.timeout(5000)})}catch{}}
export async function connectRoute(req,env,cfg){
 const path=new URL(req.url).pathname;if(!path.startsWith('/connect/'))return null;
 const origin=originFor(cfg);if(new URL(req.url).origin!==origin)issue(400,'Use the manager public URL for Cloudflare sign-in.');
 if(path==='/connect/info'&&req.method==='GET')return reply({enabled:configured(env),scope:SCOPE,manager_url:origin,model_url:origin+'/v1'});
 // Deleting this device remains possible after its keys expire or are revoked.
 // The proof is the original per-device admin secret; it never authorizes other actions here.
 if(path==='/connect/device/delete'&&req.method==='POST'){
  checkOrigin(req,origin);
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(!/^studio_admin_[a-f0-9]{64}$/.test(token))issue(401,'Use this device admin key to delete its authorization.');
  const deleted=await env.DB.prepare('DELETE FROM studio_devices WHERE manager_hash=? RETURNING id').bind(await sha(token)).first();
  // Retrying after a lost response is safe, including when the row has already gone.
  return reply({ok:true,device_deleted:!!deleted,scope:'current_device'});
 }
 if(!configured(env))issue(503,'Cloudflare sign-in is not configured. Update the manager and register an OAuth client first.');
 const callback=origin+'/connect/callback';
 if(path==='/connect/start'&&req.method==='POST'){
  checkOrigin(req,origin);const b=await body(req);if(!/^[a-f0-9]{64}$/.test(b.challenge||''))issue(400,'Invalid connection request.');
  const time=now(),id=random(),pkce=random(),ip=await sha(env.ADMIN_TOKEN+':'+(req.headers.get('CF-Connecting-IP')||'unknown'));
  await env.DB.prepare('DELETE FROM device_pairings WHERE expires<?').bind(time-3600).run();
  const inserted=await env.DB.prepare(`INSERT INTO device_pairings(id,poll_hash,pkce,ip_hash,created,expires,language)
   SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM device_pairings WHERE ip_hash=? AND created>?)<6
   AND (SELECT count(*) FROM device_pairings WHERE expires>?)<1000 RETURNING id`)
   .bind(id,b.challenge,pkce,ip,time,time+TTL,b.language==='zh-CN'?'zh-CN':'en',ip,time-TTL,time).first();
  if(!inserted)issue(429,'Too many connection attempts. Try again in 10 minutes.');
  return reply({id,authorize_url:origin+'/connect/login?id='+id,confirmation_code:id.slice(0,8).toUpperCase(),expires_at:time+TTL});
 }
 if(path==='/connect/login'&&req.method==='GET'){
  const p=await getPair(env,new URL(req.url).searchParams.get('id'));
  let c;
  if(p.state==='confirm')return confirmation(await browserPair(req,env,p.id),origin);
  if(p.state==='authorizing'){await browserPair(req,env,p.id);c=cookie(req)}
  else if(p.state==='pending'){
   c=random();const row=await env.DB.prepare("UPDATE device_pairings SET browser_hash=?,state='authorizing' WHERE id=? AND state='pending' RETURNING id").bind(await sha(c),p.id).first();if(!row)issue(409,'Connection is already in progress.');
  }else issue(409,'This sign-in link has already been opened. Start again in the app.');
  const challenge=base64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(p.pkce))));
  const url=new URL(AUTH);url.search=new URLSearchParams({client_id:env.CF_OAUTH_CLIENT_ID,response_type:'code',redirect_uri:callback,scope:SCOPE,state:p.id,code_challenge:challenge,code_challenge_method:'S256'});
  return new Response(null,{status:302,headers:{Location:url.href,'Set-Cookie':cookieHeader(c),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }
 if(path==='/connect/confirm'&&req.method==='GET'){
  const p=await browserPair(req,env,new URL(req.url).searchParams.get('id'));
  if(p.state!=='confirm')issue(409,'This connection is not awaiting confirmation.');
  return confirmation(p,origin);
 }
 if(path==='/connect/callback'&&req.method==='GET'){
  const u=new URL(req.url),p=await browserPair(req,env,u.searchParams.get('state'));if(p.state!=='authorizing')issue(409,'This sign-in response has already been processed.');
  const lock=await env.DB.prepare("UPDATE device_pairings SET state='exchanging' WHERE id=? AND state='authorizing' RETURNING id").bind(p.id).first();if(!lock)issue(409,'Connection is already in progress.');
  let accessToken='';
  try{
   const code=u.searchParams.get('code');if(u.searchParams.has('error')||!code||code.length>4096)throw Error('OAuth denied');
   const tokenResponse=await fetch(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:env.CF_OAUTH_CLIENT_ID,code,redirect_uri:callback,code_verifier:p.pkce}),redirect:'manual',signal:AbortSignal.timeout(15000)});
   if(!tokenResponse.ok)throw Error('OAuth exchange failed');const token=await tokenResponse.json();accessToken=token.access_token;
   if(typeof accessToken!=='string'||!accessToken||typeof token.scope!=='string'||!token.scope.split(/\s+/).includes(SCOPE)||String(token.token_type).toLowerCase()!=='bearer')throw Error('Required scope missing');
   // Authorization must cover this exact account and Worker. Another Cloudflare login is insufficient.
   const check=await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.CF_WORKER_NAME}/settings`,{headers:{Authorization:'Bearer '+accessToken},redirect:'manual',signal:AbortSignal.timeout(15000)});
   if(!check.ok)throw Error('Wrong account or Worker');const result=await check.json();if(result.success!==true||!result.result)throw Error('Worker access denied');
   const updated=await env.DB.prepare("UPDATE device_pairings SET state='confirm',pkce='' WHERE id=? AND state='exchanging' AND expires>? RETURNING id").bind(p.id,now()).first();if(!updated)throw Error('Expired');
   // Move the OAuth code out of the active document URL before rendering a form.
   return new Response(null,{status:303,headers:{Location:origin+'/connect/confirm?id='+p.id,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }catch{
   await env.DB.prepare("UPDATE device_pairings SET state='failed',pkce='' WHERE id=?").bind(p.id).run();
   return page(p.language==='zh-CN'?'无法完成授权':'Authorization failed',p.language==='zh-CN'?'请检查 OAuth 应用、所选账号及 Worker 权限，然后返回 APK 重试。原有连接未修改。':'Check the OAuth client, selected account and Worker permissions, then retry in the APK. Existing connections were not changed.','',p.language,403);
  }finally{if(typeof accessToken==='string'&&accessToken)await revoke(accessToken,env.CF_OAUTH_CLIENT_ID)}
 }
 if(path==='/connect/approve'&&req.method==='POST'){
  checkOrigin(req,origin,true);if(Number(req.headers.get('content-length')||0)>1024)issue(413,'Connection request too large.');
  const raw=await boundedText(req,1024);const form=new URLSearchParams(raw);
  const p=await browserPair(req,env,form.get('id'));if(p.state!=='confirm')issue(409,'This connection has already been confirmed.');
  const approved=form.get('decision')==='approve';await env.DB.prepare("UPDATE device_pairings SET state=? WHERE id=? AND state='confirm'").bind(approved?'approved':'denied',p.id).run();
  const zh=p.language==='zh-CN',response=page(zh?(approved?'设备已授权':'已取消绑定'):(approved?'Device approved':'Connection canceled'),zh?'返回 Kaggle Studio APK 即可继续。':'Return to the Kaggle Studio APK to continue.','',p.language);response.headers.set('Set-Cookie',cookieHeader('',0));return response;
 }
 if(path==='/connect/finish'&&req.method==='POST'){
  checkOrigin(req,origin);const b=await body(req),p=await getPair(env,b.id);
  if(!/^[a-f0-9]{64}$/.test(b.verifier||'')||await sha(b.verifier)!==p.poll_hash)issue(403,'Invalid device connection proof.');
  if(['failed','denied','consumed'].includes(p.state))issue(409,'Connection canceled, failed or already used. Start again.');
  if(p.state!=='approved')return reply({status:'pending'});
  const row=await env.DB.prepare("UPDATE device_pairings SET state='consumed',pkce='' WHERE id=? AND state='approved' AND expires>? RETURNING id").bind(p.id,now()).first();if(!row)issue(409,'This connection has already been used.');
  const id=crypto.randomUUID(),managerKey='studio_admin_'+random(),modelKey='studio_model_'+random(),created=now();
  await env.DB.prepare('INSERT INTO studio_devices(id,manager_hash,model_hash,created,expires) VALUES (?,?,?,?,?)').bind(id,await sha(managerKey),await sha(modelKey),created,created+DEVICE_TTL).run();
  return reply({status:'connected',manager_url:origin,model_url:origin+'/v1',manager_key:managerKey,model_key:modelKey,expires_at:created+DEVICE_TTL});
 }
 issue(404,'Connection endpoint not found.');
}
export async function deviceAuth(req,env,kind){
 const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 const prefix=kind==='manager'?'studio_admin_':'studio_model_';
 if(!token.startsWith(prefix)||!new RegExp('^'+prefix+'[a-f0-9]{64}$').test(token))return null;
 try{return await env.DB.prepare(`SELECT id,expires FROM studio_devices WHERE ${kind==='manager'?'manager_hash':'model_hash'}=? AND revoked=0 AND expires>?`).bind(await sha(token),now()).first()}catch{return null}
}
export async function deviceRoute(req,env,device){
 const path=new URL(req.url).pathname;
 if(path==='/api/device/revoke'&&req.method==='POST'){
  if(!device)issue(400,'Only a connected device can revoke its own keys.');
  await env.DB.prepare('UPDATE studio_devices SET revoked=1 WHERE id=?').bind(device.id).run();return reply({ok:true});
 }
 if(path==='/api/devices'&&req.method==='GET'){
  if(device)issue(403,'Use the original admin key to manage other devices.');
  const rows=await env.DB.prepare('SELECT id,created,expires,revoked FROM studio_devices ORDER BY created DESC LIMIT 100').all();return reply({devices:rows.results});
 }
 if(path==='/api/devices/revoke'&&req.method==='POST'){
  if(device)issue(403,'Use the original admin key to manage other devices.');const b=await body(req);if(typeof b.id!=='string'||b.id.length>64)issue(400,'Invalid device ID.');
  await env.DB.prepare('UPDATE studio_devices SET revoked=1 WHERE id=?').bind(b.id).run();return reply({ok:true});
 }
 return null;
}
