const enc=new TextEncoder();
export const randomHex=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
export const sha256=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),n=>n.toString(16).padStart(2,'0')).join('');
export const challenge=async verifier=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(verifier))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export async function seal(key,text,aad){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const imported=await crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g),v=>parseInt(v,16)),{name:'AES-GCM'},false,['encrypt']);
 const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},imported,enc.encode(text));
 return JSON.stringify({v:1,iv:btoa(String.fromCharCode(...iv)),data:btoa(String.fromCharCode(...new Uint8Array(data)))});
}
