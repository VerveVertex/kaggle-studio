// Managed models share the authenticated /v1 relay. External H3 uses a different
// protocol, so never copy the managed URL or device key into its override fields.
export function sharedModelService(settings){
 try{
  const manager=new URL(settings.managerUrl),model=new URL(settings.modelUrl);
  if(manager.protocol!=='https:'||manager.username||manager.password||manager.port||manager.pathname!=='/'||manager.search||manager.hash)return null;
  if(model.href.replace(/\/$/,'')!==manager.origin+'/v1'||!settings.modelKey)return null;
  return {url:manager.origin+'/v1',key:settings.modelKey};
 }catch{return null}
}
export function deviceConnectionPatch(data){
 return {managerUrl:data.manager_url,modelUrl:data.model_url,managerKey:data.manager_key,modelKey:data.model_key,modelId:data.model_id||''};
}
export function resolveModelService(settings,kind,managed=false){
 if(managed)return {url:settings.modelUrl,key:settings.modelKey};
 if(kind==='Video')return {url:settings.videoUrl,key:settings.videoKey};
 if(kind==='Image')return {url:settings.imageUrl||settings.modelUrl,key:settings.imageKey||settings.modelKey};
 return {url:settings.modelUrl,key:settings.modelKey};
}
export function modelSelections(settings,models){
 const choose=(key,type)=>models.some(m=>m.id===settings[key]&&(m.type||'chat')===type)?settings[key]:models.find(m=>(m.type||'chat')===type)?.id||settings[key]||'';
 return {modelId:choose('modelId','chat'),imageModel:choose('imageModel','image'),videoModel:choose('videoModel','video')};
}
