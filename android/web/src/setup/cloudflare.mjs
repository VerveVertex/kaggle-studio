export class CloudflareError extends Error{
 constructor(status,codes=[]){super('Cloudflare request failed (HTTP '+status+', codes '+codes.join(',')+').');this.status=status;this.codes=codes;this.requiresAuthorization=status===401||status===403&&codes.some(c=>[10000,9106,9109].includes(c));this.definitive=status>=400&&status<500&&status!==408;}
}
export function cloudflareExpired(auth,now=Date.now()/1000){return !auth?.accessToken||!Number.isFinite(auth.expires)||auth.expires<=now+30;}
export class CloudflareAuthorizationError extends CloudflareError{
 constructor(){super(401);this.message='Cloudflare sign-in expired. Sign in again to resume.';this.requiresAuthorization=true;this.beforeRequest=true;}
}
export class Cloudflare{
 constructor(auth,transport=fetch){this.auth=auth;this.transport=transport;}
 async request(path,{method='GET',body}={}){
  if(!path.startsWith('/')||path.includes('..')||path.includes('?')&&/https?:/i.test(path))throw Error('Invalid Cloudflare API path.');
  if(cloudflareExpired(this.auth))throw new CloudflareAuthorizationError();
  const headers={Authorization:'Bearer '+this.auth.accessToken,Accept:'application/json'};
  const form=body instanceof FormData;if(body!==undefined&&!form)headers['Content-Type']='application/json';
  let r;try{r=await this.transport('https://api.cloudflare.com/client/v4'+path,{method,headers,body:body===undefined?undefined:form?body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(25000)})}catch{throw new CloudflareError(0)}
  if(r.status===204&&r.ok)return {success:true,result:null};
  let b;try{b=await r.json()}catch{throw new CloudflareError(r.status)}
  if(!r.ok||b.success!==true)throw new CloudflareError(r.status,(b.errors||[]).map(x=>x.code).filter(Number.isFinite));
  return b;
 }
 async get(path){return (await this.request(path)).result;}
 async put(path,body){return (await this.request(path,{method:'PUT',body})).result;}
 async post(path,body){return (await this.request(path,{method:'POST',body})).result;}
 async all(path){
  const found=[];
  for(let page=1;page<=100;page++){
   const b=await this.request(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);
   if(!Array.isArray(b.result))throw Error('Unexpected Cloudflare list response.');found.push(...b.result);
   if((b.result_info?.total_pages!==undefined&&page>=b.result_info.total_pages)||b.result.length<100)return found;
  }
  throw Error('Cloudflare returned too many resources. Narrow the account selection.');
 }
 async accounts(){return (await this.all('/accounts')).map(a=>({id:a.id,name:a.name})).filter(a=>/^[a-f0-9]{32}$/.test(a.id));}
 async sql(account,id,sql,params=[]){
  const result=await this.post('/accounts/'+account+'/d1/database/'+id+'/query',{sql,params});
  if(!Array.isArray(result)||result.some(x=>x.success!==true))throw Error('Database query did not complete.');return result.flatMap(x=>x.results||[]);
 }
}
