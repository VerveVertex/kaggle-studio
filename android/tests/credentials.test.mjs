import test from 'node:test';
import assert from 'node:assert/strict';
import {clearServiceKeys,deleteDeviceAuthorization} from '../web/src/credentials.mjs';
const settings={managerUrl:'https://gpu.example.com',managerKey:'studio_admin_'+'a'.repeat(64),modelKey:'studio_model_'+'b'.repeat(64),imageKey:'image-key',videoKey:'video-key'};
test('device credentials are cleared only after the manager confirms scoped remote deletion',async()=>{
 const original={...settings},seen=[];
 const keys=await clearServiceKeys(settings,async(...args)=>{seen.push(args);return {ok:true,device_deleted:true,scope:'current_device'}});
 assert.deepEqual(seen,[['manager_device_delete',settings.managerUrl,settings.managerKey]]);
 assert.deepEqual(keys,{modelKey:'',managerKey:'',imageKey:'',videoKey:''});assert.deepEqual(settings,original);
});
test('manual original keys cause no remote deletion request',async()=>{
 let calls=0;const input={...settings,managerKey:'original-admin-key',modelKey:'original-model-key'};
 const keys=await clearServiceKeys(input,async()=>{calls++;throw Error('must not call Cloudflare')});
 assert.equal(calls,0);assert.equal(keys.managerKey,'');assert.equal(input.managerKey,'original-admin-key');
});
test('failed deletion or an old server acknowledgement retains the saved credentials for retry',async()=>{
 const original={...settings};
 await assert.rejects(clearServiceKeys(settings,async()=>{throw Error('offline')}),/offline/);
 await assert.rejects(clearServiceKeys(settings,async()=>({ok:true})),/0.1.8/);
 assert.deepEqual(settings,original);
});
test('idempotent retries allow cleanup when a previous response was lost, while partial device credentials require reconnection',async()=>{
 const keys=await clearServiceKeys(settings,async()=>({ok:true,device_deleted:false,scope:'current_device'}));assert.equal(keys.modelKey,'');
 await assert.rejects(deleteDeviceAuthorization({...settings,managerKey:''}),/device admin key/);
 await assert.rejects(clearServiceKeys({...settings,managerKey:''}),/Reconnect Cloudflare/);
});
