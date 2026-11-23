import test from 'node:test';
import assert from 'node:assert/strict';
let handler, cancelled=[],vault='{}',savedFile=[];
globalThis.StudioNative={
 request(id,raw){handler(id,JSON.parse(raw))},
 cancel(id){cancelled.push(id)},
 readKeys(){return vault},saveKeys(raw){vault=raw;return true},
 beginFile(){savedFile=[];return 'export-1'},
 appendFile(id,data){savedFile.push(Buffer.from(data,'base64'));return true},
 finishFile(id){assert.equal(id,'export-1')},cancelFile(){},copy(){},setTheme(){},openExternal(){}
};
const {nativeFetch,receiveNative,readKeys,saveKeys,saveBlob}=await import('../web/src/native.mjs');
const {chatCompletion,jsonBridge,bridge}=await import('../web/src/services.js');
const {handleApi,validateTarget}=await import('../web/src/api.mjs');
const {sessionState}=await import('../web/src/session.mjs');
function headers(id,status=200,type='application/json'){receiveNative({id,type:'headers',status,headers:{'content-type':type}})}
function chunk(id,value){receiveNative({id,type:'chunk',data:Buffer.from(value).toString('base64')})}
function end(id){receiveNative({id,type:'end'})}
function reply(id,value,status=200){headers(id,status);chunk(id,JSON.stringify(value));end(id)}

test('standalone model discovery uses native HTTPS with the model key only in Authorization',async()=>{
 handler=(id,request)=>{
  assert.equal(request.url,'https://llm.example.com/v1/models');assert.equal(request.method,'GET');
  assert.equal(request.headers.authorization,'Bearer model-secret');assert.equal(request.body,null);
  reply(id,{data:[{id:'qwen3.6-35b-a3b'}]});
 };
 const data=await jsonBridge('models','https://llm.example.com/v1','model-secret');
 assert.equal(data.data[0].id,'qwen3.6-35b-a3b');
});
test('streaming preserves SSE and UTF-8 split across native byte chunks',async()=>{
 handler=(id,request)=>{
  const payload=JSON.parse(Buffer.from(request.body,'base64').toString());
  assert.equal(payload.stream,true);assert.equal(payload.model,'qwen');
  assert(!('key' in payload));assert(request.url.endsWith('/chat/completions'));
  headers(id,200,'text/event-stream');
  const raw=Buffer.from('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n');
  for(let offset=0;offset<raw.length;offset+=7)chunk(id,raw.subarray(offset,offset+7));end(id);
 };
 let text='';await chatCompletion([{role:'user',content:'Hi'}],'qwen',{modelUrl:'https://llm.example.com/v1',modelKey:'model-secret',streaming:true},undefined,t=>text=t);
 assert.equal(text,'你好 world');
});
test('abort before response headers cancels the Android HTTP request',async()=>{
 const controller=new AbortController();let id;
 handler=value=>{id=value;queueMicrotask(()=>controller.abort())};cancelled=[];
 await assert.rejects(nativeFetch('https://llm.example.com/v1/models',{signal:controller.signal}),{name:'AbortError'});
 assert.deepEqual(cancelled,[id]);
});
test('abort during a stream errors the reader and cancels the native call',async()=>{
 const controller=new AbortController();let id;
 handler=value=>{id=value;headers(id,200,'text/event-stream')};
 const response=await nativeFetch('https://llm.example.com/v1/chat/completions',{signal:controller.signal});
 const reader=response.body.getReader();controller.abort();
 await assert.rejects(reader.read(),{name:'AbortError'});assert(cancelled.includes(id));
 // A late Android completion must not reopen an aborted request.
 chunk(id,'late');end(id);
});
test('upstream authentication errors remain visible to connection settings',async()=>{
 handler=id=>reply(id,{error:{message:'Invalid API Key'}},401);
 await assert.rejects(jsonBridge('models','https://llm.example.com/v1','wrong-key'),/Invalid API Key/);
});
test('manager start and stop target distinct endpoints with the admin key',async()=>{
 const seen=[];
 handler=(id,req)=>{seen.push(req);reply(id,{run:{active:1}})};
 await jsonBridge('manager_start','https://gpu.example.com','admin-secret');
 await jsonBridge('manager_stop','https://gpu.example.com','admin-secret');
 assert.deepEqual(seen.map(r=>r.url),['https://gpu.example.com/api/start','https://gpu.example.com/api/stop']);
 assert(seen.every(r=>r.method==='POST'&&r.headers.authorization==='Bearer admin-secret'));
});
test('private URLs, traversal and arbitrary service actions are refused before native networking',async()=>{
 let calls=0;handler=()=>calls++;
 for(const url of ['http://host.example','https://127.0.0.1','https://user:pass@example.com','https://a.local','https://example.com:9999'])assert.throws(()=>validateTarget(url));
 await assert.rejects(bridge('execute','https://gpu.example.com','admin-secret'),/Unsupported/);
 await assert.rejects(bridge('video_file','https://video.example.com','video-secret',undefined,{extra:{file:{filename:'test.mp4',subfolder:'../secret'}}}),/Invalid video file/);
 assert.equal(calls,0);
});
test('H3 upload arrives as image bytes rather than JSON containing a private gateway key',async()=>{
 const image=Buffer.from([1,2,3,4,255]);
 handler=(id,request)=>{
  assert.equal(request.url,'https://video.example.com/studio/api/upload');
  assert.equal(request.headers['content-type'],'image/png');
  assert.deepEqual(Buffer.from(request.body,'base64'),image);reply(id,{filename:'input.png'});
 };
 const result=await jsonBridge('video_upload','https://video.example.com','video-secret',undefined,{extra:{data:image.toString('base64')}});
 assert.equal(result.filename,'input.png');
});
test('binary media responses are reconstructed without text decoding',async()=>{
 const original=Buffer.from([0,1,255,128,44]);handler=id=>{headers(id,200,'video/mp4');chunk(id,original);end(id)};
 const response=await bridge('video_file','https://video.example.com','video-secret',undefined,{extra:{file:{filename:'test.mp4',type:'output'}}});
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
});
test('keys use the Android vault interface and file exports are chunked byte-for-byte',async()=>{
 saveKeys({modelKey:'model-secret',managerKey:'admin-secret'});
 assert.equal(readKeys().managerKey,'admin-secret');
 const data=Buffer.alloc(180000);for(let i=0;i<data.length;i++)data[i]=i%251;
 await saveBlob(new Blob([data]),'creation.mp4');
 assert.equal(savedFile.length,3);assert.deepEqual(Buffer.concat(savedFile),data);
});
test('unavailable manager sessions cannot be shown as ready',()=>{
 const manager={run:{active:1,service:'ready',started:100,heartbeat:150,remaining_seconds_estimate:100}};
 assert.equal(sessionState(manager,180).ready,true);assert.equal(sessionState(manager,230).ready,false);
 assert.equal(sessionState({run:{...manager.run,active:0,ended:220,kaggle_state:'ERROR'}},230).active,false);
});
test('the local API handler still enforces a bounded JSON request',async()=>{
 const response=await handleApi(new Request('https://appassets.androidplatform.net/api/bridge',{method:'POST',headers:{'content-length':String(19*1024*1024)},body:'{}'}));
 assert.equal(response.status,413);
});
test('Kaggle model discovery uses the admin-authenticated read-only manager endpoint',async()=>{
 handler=(id,request)=>{
   assert.equal(request.url,'https://gpu.example.com/api/models');assert.equal(request.method,'GET');
   assert.equal(request.headers.authorization,'Bearer admin-secret');
   reply(id,{models:[{id:'notebook-model',source:'kaggle_notebook',status:'configured'}]});
 };
 const result=await jsonBridge('manager_models','https://gpu.example.com','admin-secret');
 assert.equal(result.models[0].id,'notebook-model');
});
test('Cloudflare pairing uses only public fixed endpoints; device proof is in POST body without a service key',async()=>{
 handler=(id,request)=>{assert.equal(request.url,'https://gpu.example.com/connect/start');assert(!request.headers.authorization);assert.equal(request.method,'POST');const body=JSON.parse(Buffer.from(request.body,'base64').toString());assert.equal(body.challenge,'a'.repeat(64));assert(!('key' in body));reply(id,{id:'pending'})};
 await jsonBridge('cloudflare_begin','https://gpu.example.com','',{challenge:'a'.repeat(64)});
 handler=(id,request)=>{assert.equal(request.url,'https://gpu.example.com/connect/finish');assert(!request.headers.authorization);const body=JSON.parse(Buffer.from(request.body,'base64').toString());assert.equal(body.verifier,'proof');reply(id,{status:'pending'})};
 await jsonBridge('cloudflare_finish','https://gpu.example.com','',{id:'pair',verifier:'proof'});
 await assert.rejects(jsonBridge('manager_status','https://gpu.example.com',''),/Add the API key/);
});
test('device deletion is an authenticated POST to a fixed endpoint and preserves the device proof',async()=>{
 handler=(id,request)=>{assert.equal(request.url,'https://gpu.example.com/connect/device/delete');assert.equal(request.method,'POST');assert.equal(request.headers.authorization,'Bearer studio_admin_'+'a'.repeat(64));reply(id,{ok:true,device_deleted:true,scope:'current_device'})};
 const data=await jsonBridge('manager_device_delete','https://gpu.example.com','studio_admin_'+'a'.repeat(64));assert(data.device_deleted);
});
