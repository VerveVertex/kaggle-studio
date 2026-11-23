import {jsonBridge} from './services.js';
import {managerOrigin} from './pairing.mjs';
const deviceAdmin=key=>typeof key==='string'&&/^studio_admin_[a-f0-9]{64}$/.test(key);
const deviceModel=key=>typeof key==='string'&&key.startsWith('studio_model_');
export async function deleteDeviceAuthorization(settings,request=jsonBridge){
 if(!deviceAdmin(settings.managerKey))throw Error('A valid device admin key is needed to delete this device. Reconnect Cloudflare first.');
 const base=managerOrigin(settings.managerUrl);
 const result=await request('manager_device_delete',base,settings.managerKey);
 if(result?.ok!==true||typeof result.device_deleted!=='boolean'||result.scope!=='current_device')throw Error('Update the manager to 0.1.8 or later before deleting device keys.');
 return result;
}
export async function clearServiceKeys(settings,request=jsonBridge){
 if(deviceAdmin(settings.managerKey))await deleteDeviceAuthorization(settings,request);
 else if(settings.managerKey?.startsWith('studio_admin_')||deviceModel(settings.modelKey))throw Error('A valid device admin key is needed to delete this device. Reconnect Cloudflare first.');
 // A manually entered original service key is removed locally only. Never call Cloudflare APIs.
 return {modelKey:'',managerKey:'',imageKey:'',videoKey:''};
}
