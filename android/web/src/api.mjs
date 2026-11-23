export function validateTarget(value) {
  let u; try {u=new URL(value)} catch {throw new Error('Enter a valid HTTPS service URL.')}
  const h=u.hostname.toLowerCase();
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port||h.includes(':')||
    /^\d+(\.\d+){3}$/.test(h)||!h.includes('.')||['localhost','metadata.google.internal'].includes(h)||
    /\.(localhost|local|internal|test|lan)$/.test(h))throw new Error('Use a public HTTPS hostname without credentials or a custom port.');
  return u.toString().replace(/\/$/,'');
}
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function handleApi(request,env={},transport=fetch) {
  const path=new URL(request.url).pathname;
  if(path==='/api/health')return response({ok:true,configured:false,version:'0.2.0'});
  // Android-only local handler. Service credentials are checked by the remote service.
  if(path==='/api/identity')return response({id:'local-android-device'});
  if(path!=='/api/bridge'||request.method!=='POST')return response({error:'Endpoint not found.'},404);
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return response({error:'Cross-origin requests are not allowed.'},403);
  if(Number(request.headers.get('content-length')||0)>18*1024*1024)return response({error:'This request exceeds the 18 MB limit.'},413);
  let b;try{const reader=request.body?.getReader();if(!reader)return response({error:'Expected a JSON request.'},400);let size=0,chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>18*1024*1024){await reader.cancel();return response({error:'This request exceeds the 18 MB limit.'},413)}chunks.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}b=JSON.parse(new TextDecoder().decode(bytes));if(!b||typeof b!=='object'||Array.isArray(b))throw Error()}catch{return response({error:'Expected a JSON request.'},400)}
  try {
    const base=validateTarget(b.base);
    const publicPairing=['cloudflare_begin','cloudflare_finish'].includes(b.action);
    if(publicPairing&&new URL(base).pathname!=='/')throw new Error('Use your manager root URL without /v1.');
    if(!publicPairing&&(typeof b.key!=='string'||!b.key.trim()))return response({error:'Add the API key for this service in Settings.'},400);
    const actions={
      cloudflare_begin:['POST','/connect/start'],cloudflare_finish:['POST','/connect/finish'],manager_device_revoke:['POST','/api/device/revoke'],manager_device_delete:['POST','/connect/device/delete'],
      models:['GET','/models'],chat:['POST','/chat/completions'],image:['POST','/images/generations'],
      manager_select:['POST','/api/model/select'],manager_models:['GET','/api/models'],manager_status:['GET','/api/status'],manager_quota:['GET','/api/quota'],manager_start:['POST','/api/start'],
      manager_health:['GET','/healthz'],manager_diagnostics:['GET','/api/diagnostics'],manager_manual_ended:['POST','/api/manual-ended'],
      manager_context:['POST','/api/context'],manager_stop:['POST','/api/stop'],manager_refresh:['POST','/api/refresh'],
      video_create:['POST','/studio/api/generate'],video_cancel:['POST','/studio/api/cancel']
    };
    let method,suffix;
    if(b.action.startsWith('job_')){
      if(!['chat','image','video'].includes(b.kind)||!['job_create','job_status','job_file','job_cancel'].includes(b.action))throw Error('Invalid task operation.');
      if(!/^[a-f0-9]{32}$/.test(b.jobId||''))throw Error('Invalid task ID.');
      const path='/'+(b.kind==='chat'?'chat':'media')+'/jobs';
      [method,suffix]=b.action==='job_create'?['POST',path]:b.action==='job_cancel'?['POST',path+'/'+b.jobId+'/cancel']:['GET',path+'/'+b.jobId+(b.action==='job_file'?'/file':'?offset='+Math.max(0,Number(b.offset)||0))];
    }else if(b.action==='video_status'){
      if(!/^[\w-]{1,100}$/.test(b.jobId||''))throw new Error('Invalid video job ID.');
      [method,suffix]=['GET','/studio/api/jobs/'+b.jobId];
    }else if(b.action==='video_upload'){
      if(typeof b.data!=='string'||b.data.length>14*1024*1024)throw new Error('Choose an image smaller than 10 MB.');
      [method,suffix]=['POST','/studio/api/upload'];
    }else if(b.action==='video_file'){
      const f=b.file||{};
      if(!/^[\w .()-]+\.(mp4|webm|mov|mkv)$/i.test(f.filename||'')||/(^|[\/\\])\.\.([\/\\]|$)/.test(f.subfolder||'')||!(f.type==='output'||!f.type))throw new Error('Invalid video file.');
      [method,suffix]=['GET','/view?'+new URLSearchParams({filename:f.filename,subfolder:f.subfolder||'',type:'output'})];
    }else if(actions[b.action]){[method,suffix]=actions[b.action]}
    else return response({error:'Unsupported service action.'},400);
    if(['chat','image'].includes(b.action)&&(!b.payload||typeof b.payload!=='object'))throw new Error('Missing request content.');
    const headers={'Content-Type':'application/json',...(!publicPairing?{'Authorization':'Bearer '+b.key.trim()}:{})};
    let body=method==='POST'?JSON.stringify(b.payload||{}):undefined;
    if(b.action==='video_upload'){
      headers['Content-Type']='image/png';
      try{body=Uint8Array.from(atob(b.data),c=>c.charCodeAt(0))}catch{throw new Error('The image could not be read.')}
    }
    const upstream=await transport(base+suffix,{method,headers,body,redirect:'manual',signal:request.signal});
    if(!upstream.ok){
      let detail='';try{const raw=await upstream.text();const d=JSON.parse(raw);detail=typeof d.error==='string'?d.error:d.error?.message||d.detail||''}catch{}
      if(typeof detail!=='string')detail='';
      if(!detail)detail=upstream.status===413?'Request too large. Reduce images or conversation history.':[408,504,524].includes(upstream.status)?'The model took too long to process the input. Update the manager to use background tasks, or reduce conversation history.':upstream.status===503?'The model is not ready. Wait for Ready in Compute.':'The service returned HTTP '+upstream.status+'.';
      return response({error:String(detail||('The service returned HTTP '+upstream.status+'.')).slice(0,1500)},upstream.status>=400&&upstream.status<600?upstream.status:502);
    }
    return new Response(upstream.body,{status:upstream.status,headers:{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch(e){if(e.name==='AbortError'||request.signal.aborted)throw new DOMException('Aborted','AbortError');return response({error:e.message||'The connected service could not be reached.'},e instanceof TypeError?502:400)}
}
