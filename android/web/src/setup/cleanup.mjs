import {nativeFetch} from '../native.mjs';
import {deleteDeviceAuthorization} from '../credentials.mjs';
import {revokeCloudflare} from './oauth.mjs';
export async function clearSetupCredentials({native=globalThis.StudioNative,transport=nativeFetch,removeDevice=deleteDeviceAuthorization}={}){
 if(!native?.readSetup)return;
 let saved;try{saved=JSON.parse(native.readSetup())}catch{throw Error('Saved setup credentials could not be read. They were kept.');}
 if(saved.storage_error)throw Error('Saved setup credentials could not be decrypted. They were kept.');
 if(!Object.keys(saved).length)return;
 if(saved.removal&&saved.removal.step<5)throw Error('Finish or resume deployment deletion before clearing its recovery record.');
 // An unfinished setup may already have minted a device row. Remove only that row, never server Secrets.
 const plan=saved.plan;
 if(plan?.step>=10&&plan?.device?.manager&&plan.subdomain&&plan.worker){
  await removeDevice({managerUrl:'https://'+plan.worker+'.'+plan.subdomain+'.workers.dev',managerKey:plan.device.manager});
 }
 if(saved.cloudflare&&!saved.cloudflareRevoked&&!plan?.cloudflareRevoked)await revokeCloudflare(saved.cloudflare,transport);
 if(saved.pending?.state)native.cancelOAuthCallback?.(saved.pending.state);
 // Do not revoke the Kaggle grant that is already installed in the user's manager.
 if(native.saveSetup('{}')!==true)throw Error('Setup credential cleanup failed. Retry clearing keys.');
}
