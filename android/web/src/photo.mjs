// Bound camera uploads before base64 encoding: manager requests are limited to 4 MiB.
export async function preparePhoto(file){
 if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>25*1024*1024)throw Error('Choose a PNG, JPEG, or WebP image smaller than 25 MB.');
 const url=URL.createObjectURL(file);
 try{
  const image=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('This photo could not be read.'));i.src=url});
  const ratio=Math.min(1,1600/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('This photo could not be prepared.');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  for(const quality of [.85,.7,.5]){const data=canvas.toDataURL('image/jpeg',quality);if(data.startsWith('data:image/jpeg;base64,')&&data.length<=2800000)return data;}
  throw Error('This photo is too large. Try a smaller image.');
 }finally{URL.revokeObjectURL(url)}
}
