import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
export const account='a'.repeat(32),username='tester';
export const auth={accessToken:'cf-test-only',expires:Date.now()/1000+3600,clientId:'test-public-studio'};
export function harness(){
 const databases=new Map(),scripts=new Map(),tunnels=new Map(),services=new Map(),creates={},calls=[];let subdomain='existing-studio',uploadedEnv;
 function d1(db){return {prepare(sql){return {values:[],bind(...values){this.values=values;return this;},async first(){return db.prepare(sql).get(...this.values)||null},async all(){return {results:db.prepare(sql).all(...this.values)}},async run(){return db.prepare(sql).run(...this.values)}}}}}
 const transport=async(input,options={})=>{
  const url=new URL(input),path=url.pathname,method=options.method||'GET';calls.push([method,url.href]);
  const okay=result=>Response.json({success:true,result});const fail=status=>Response.json({success:false,errors:[{code:10007}]},{status});
  if(url.hostname==='api.kaggle.com'){assert(path.endsWith('/ListKernels'),'Installer must never submit GPU work');return Response.json({kernels:[]});}
  if(url.hostname.endsWith('.workers.dev')){
   const pair=[...scripts.entries()].find(([name])=>url.hostname.startsWith(name+'.'));if(!pair)return new Response('',{status:404});
   const meta=pair[1].metadata;const env=Object.fromEntries(meta.bindings.filter(b=>b.text!==undefined).map(b=>[b.name,b.text]));
   env.DB=d1(databases.get(meta.bindings.find(b=>b.type==='d1').id));
   env.MODEL_VPC={fetch:async()=>Response.json({data:[{id:'fake-model'}]})};
   uploadedEnv=env;
   const mod=await import('data:text/javascript;base64,'+Buffer.from(pair[1].source).toString('base64'));
   return mod.default.fetch(new Request(url,options),env);
  }
  assert.equal(url.hostname,'api.cloudflare.com');assert.equal(options.headers.Authorization,'Bearer '+auth.accessToken);assert.equal(options.redirect,'manual');
  const p=path.replace('/client/v4','');
  if(p==='/accounts')return okay([{id:account,name:'Test Account'}]);
  if(p.endsWith('/workers/subdomain')){if(method==='PUT')subdomain=JSON.parse(options.body).subdomain;return okay({subdomain});}
  if(p.endsWith('/d1/database')&&method==='POST'){creates.database=(creates.database||0)+1;const id=crypto.randomUUID();const db=new DatabaseSync(':memory:');db.resourceName=JSON.parse(options.body).name;databases.set(id,db);return okay({uuid:id});}
  const dbDetail=p.match(/\/d1\/database\/([^/]+)$/);if(dbDetail){const db=databases.get(dbDetail[1]);if(!db)return fail(404);if(method==='DELETE'){databases.delete(dbDetail[1]);return okay(null)}return okay({uuid:dbDetail[1],name:db.resourceName})}
  const tunnelDetail=p.match(/\/cfd_tunnel\/([^/]+)$/);if(tunnelDetail){const item=tunnels.get(tunnelDetail[1]);if(!item)return fail(404);if(method==='DELETE'){item.deleted_at='2026-11-21T00:00:00Z';return okay(null)}return okay(item)}
  const serviceDetail=p.match(/\/connectivity\/directory\/services\/([^/]+)$/);if(serviceDetail){const item=services.get(serviceDetail[1]);if(!item)return fail(404);if(method==='DELETE'){services.delete(serviceDetail[1]);return new Response(null,{status:204})}return okay(item)}
  const query=p.match(/\/d1\/database\/([^/]+)\/query$/);if(query){const db=databases.get(query[1]);if(!db)return fail(404);const {sql,params=[]}=JSON.parse(options.body);
   try{let results=[];if(sql.includes(';')&&!params.length)db.exec(sql);else{const statement=db.prepare(sql);try{results=statement.all(...params)}catch{statement.run(...params)}}return okay([{success:true,results}]);}catch(e){throw new Error('Mock database failure: '+e.message);}}
  if(p.endsWith('/cfd_tunnel')&&method==='POST'){creates.tunnel=(creates.tunnel||0)+1;const item={id:crypto.randomUUID(),name:JSON.parse(options.body).name,token:'fake-tunnel-token'};tunnels.set(item.id,item);return okay(item);}
  if(p.endsWith('/connectivity/directory/services')&&method==='POST'){creates.vpc=(creates.vpc||0)+1;const b=JSON.parse(options.body);assert.equal(b.host.ipv4,'127.0.0.1');assert.equal(b.http_port,8080);const item={...b,service_id:crypto.randomUUID()};services.set(item.service_id,item);return okay(item);}
  if(p.endsWith('/workers/scripts')&&method==='GET')return okay([...scripts.keys()].map(id=>({id})));
  const worker=p.match(/\/workers\/scripts\/([\w-]+)(\/settings|\/subdomain)?$/);
  if(worker){const name=worker[1];
   if(worker[2]==='/settings'){const s=scripts.get(name);return s?okay({bindings:s.metadata.bindings.map(b=>b.type==='secret_text'?{name:b.name,type:b.type}:b)}):fail(404);}
   if(worker[2]==='/subdomain')return okay({enabled:true,previews_enabled:false});
   if(method==='DELETE'){scripts.delete(name);return okay(null)}
   if(method==='PUT'){creates.worker=(creates.worker||0)+1;assert(options.body instanceof FormData);const metadata=JSON.parse(options.body.get('metadata'));if(metadata.keep_bindings?.includes('secret_text')){const replacements=new Set(metadata.bindings.map(b=>b.name));metadata.bindings.push(...(scripts.get(name)?.metadata.bindings||[]).filter(b=>b.type==='secret_text'&&!replacements.has(b.name)))}scripts.set(name,{metadata,source:await options.body.get('worker.mjs').text()});return okay({id:name});}
  }
  throw Error('Unexpected test path: '+method+' '+p);
 };
 return {transport,databases,scripts,tunnels,services,creates,calls,get env(){return uploadedEnv},clearSubdomain(){subdomain=''}};
}
