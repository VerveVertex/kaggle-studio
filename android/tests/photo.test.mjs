import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparePhoto} from '../web/src/photo.mjs';

test('large camera photo becomes an upright bounded JPEG and temporary object URLs are revoked on success/failure',async()=>{
 const originals={Image:globalThis.Image,document:globalThis.document,create:URL.createObjectURL,revoke:URL.revokeObjectURL};let revoked=0,qualityCalls=[],canvas,fail=false;
 URL.createObjectURL=()=> 'blob:camera-fixture';URL.revokeObjectURL=url=>{assert.equal(url,'blob:camera-fixture');revoked++};
 globalThis.Image=class{naturalWidth=4000;naturalHeight=3000;set src(value){queueMicrotask(()=>fail?this.onerror():this.onload())}};
 globalThis.document={createElement:tag=>{assert.equal(tag,'canvas');canvas={getContext:()=>({fillRect(){},drawImage(){},set fillStyle(v){}}),toDataURL:(format,quality)=>{assert.equal(format,'image/jpeg');qualityCalls.push(quality);return 'data:image/jpeg;base64,'+'a'.repeat(quality>.7?2900000:100)}};return canvas}};
 try{
  const result=await preparePhoto({type:'image/jpeg',size:8*1024*1024});assert(result.length<2800000);assert.equal(canvas.width,1600);assert.equal(canvas.height,1200);assert.deepEqual(qualityCalls,[.85,.7]);assert.equal(revoked,1);
  fail=true;await assert.rejects(preparePhoto({type:'image/jpeg',size:100}),/could not be read/);assert.equal(revoked,2);
  await assert.rejects(preparePhoto({type:'text/plain',size:100}),/Choose a PNG/);assert.equal(revoked,2);
 }finally{globalThis.Image=originals.Image;globalThis.document=originals.document;URL.createObjectURL=originals.create;URL.revokeObjectURL=originals.revoke}
});
