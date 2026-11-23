const native = globalThis.StudioNative;
const pending = new Map();
let serial = 0;
function base64(bytes) {
  let binary='';
  for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(binary);
}
function bytes(value) {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
function finish(id) {
  const item=pending.get(id);
  if(item){item.cleanup?.();pending.delete(id)}
  return item;
}
export function receiveNative(event) {
  const item=pending.get(event.id);if(!item)return;
  if(event.type==='headers') {
    try {
      item.resolve(new Response([204,205,304].includes(event.status)?null:item.stream,
        {status:event.status,headers:event.headers||{}}));
      item.resolved=true;
    }catch {finish(event.id);item.reject(new Error('The service returned an invalid response.'))}
  }else if(event.type==='chunk') {
    try {item.controller.enqueue(bytes(event.data))}catch {finish(event.id);native?.cancel(event.id)}
  }else if(event.type==='end') {
    finish(event.id);try{item.controller.close()}catch{}
  }else if(event.type==='error') {
    finish(event.id);const error=new Error(event.message||'The connected service could not be reached.');
    if(item.resolved){try{item.controller.error(error)}catch{}}else item.reject(error);
  }
}
globalThis.__studioNetwork=receiveNative;
export async function nativeFetch(input,init) {
  if(!native)return fetch(input,init);
  const req=new Request(input,init);
  if(req.signal.aborted)throw new DOMException('Aborted','AbortError');
  const body=['GET','HEAD'].includes(req.method)?null:await req.arrayBuffer();
  if(req.signal.aborted)throw new DOMException('Aborted','AbortError');
  const id='http-'+(++serial);
  return new Promise((resolve,reject)=>{
    const item={resolve,reject,resolved:false};
    item.stream=new ReadableStream({start(c){item.controller=c},cancel(){finish(id);native.cancel(id)}});
    const abort=()=>{
      finish(id);native.cancel(id);const e=new DOMException('Aborted','AbortError');
      if(item.resolved){try{item.controller.error(e)}catch{}}else reject(e);
    };
    item.cleanup=()=>req.signal.removeEventListener('abort',abort);
    pending.set(id,item);req.signal.addEventListener('abort',abort,{once:true});
    if(req.signal.aborted){abort();return}
    try {
      native.request(id,JSON.stringify({url:req.url,method:req.method,headers:Object.fromEntries(req.headers),
        body:body?base64(new Uint8Array(body)):null}));
    }catch {finish(id);reject(new Error('The Android connection could not be started.'))}
  });
}
export function readKeys() {
  try{return JSON.parse(native?native.readKeys():(sessionStorage.getItem('studio-keys')||'{}'))}catch{return {}}
}
export function saveKeys(keys) {
  if(native)return native.saveKeys(JSON.stringify(keys));
  else sessionStorage.setItem('studio-keys',JSON.stringify(keys));
}
export async function copyText(text) {
  if(native)native.copy(String(text));else await navigator.clipboard.writeText(text);
}
export function setNativeTheme(dark,mode) {if(mode)native?.setThemeMode?.(mode);native?.setTheme(!!dark)}
export async function saveBlob(blob,name,share=false) {
  if(!native&&share){const file=new File([blob],name,{type:blob.type});if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file]});return}throw Error('System sharing is unavailable. Download the file instead.');}
  if(!native){const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return}
  if(blob.size>256*1024*1024)throw new Error('Choose a file smaller than 256 MB.');
  const id=native.beginFile(name,blob.type||'application/octet-stream');
  if(!id)throw new Error('Finish the current file export first.');
  try {
    for(let offset=0;offset<blob.size;offset+=65536){
      const chunk=new Uint8Array(await blob.slice(offset,offset+65536).arrayBuffer());
      if(!native.appendFile(id,base64(chunk)))throw new Error('The file could not be saved.');
    }
    if(share){if(!native.finishShareFile(id))throw Error('The media could not be shared.');}else native.finishFile(id);
  }catch(e){native.cancelFile(id);throw e}
}
if(native&&typeof window!=='undefined')window.open=url=>{try{native.openExternal(new URL(url,location.href).href)}catch{}return null};

export async function shareText(text){if(native?.shareText){native.shareText(String(text));return}if(navigator.share){await navigator.share({text:String(text)});return}throw Error('System sharing is unavailable. Copy the text instead.');}
