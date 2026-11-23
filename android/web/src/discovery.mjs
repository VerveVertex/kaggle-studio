import {normalizeLanguage} from './i18n.mjs';
export const defaults={language:'en',theme:'system',accent:'#52525b',videoModel:'',streaming:true,modelUrl:'',managerUrl:'',videoUrl:'',imageUrl:'',
  modelId:'',imageModel:'',videoPreset:'smoke',connectionSchema:2};

export function loadSettings(raw,keys={}) {
  let saved={};
  try{const parsed=JSON.parse(raw||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))saved=parsed}catch{}
  if(saved.connectionSchema!==2){
    // The first APK persisted bundled defaults even before any connection was made.
    // Keep authenticated connections; discard unauthenticated seed/draft values.
    if(!keys.modelKey)saved.modelUrl='';
    if(!keys.managerKey)saved.managerUrl='';
    saved.modelId='';saved.imageModel='';
  }
  return {...defaults,...saved,...keys,language:normalizeLanguage(saved.language),connectionSchema:2};
}
const validId=id=>typeof id==='string'&&id.trim().length>0&&id.length<=256&&!/[\u0000-\u001f\u007f]/.test(id);
export function apiModelList(data) {
  if(!Array.isArray(data))return [];
  return data.filter(m=>m&&validId(m.id));
}
export function discoveredModels(apiModels=[],notebookModels=[]) {
  const models=new Map();
  for(const model of notebookModels){
    if(!validId(model?.id))continue;
    const source=model.source==='manager_deployment'?'Manager deployment':model.source==='kaggle_notebook'?'Kaggle notebook':'Manager profile';
    models.set(model.id,{id:model.id,name:(model.name||model.id).replace(/\s*\(experimental\)/gi,''),capabilities:model.capabilities,type:({image:'Image',video:'Video'})[model.type]||'Chat',source,
      detail:model.notebook_ref||'Configured service model',status:model.status==='ready'?'Ready':'Configured',reported:model.status==='ready'});
  }
  for(const model of apiModelList(apiModels)){
    const previous=models.get(model.id);
    const type=({image:'Image',video:'Video'})[String(model.type||'').toLowerCase()]||'Chat';
    models.set(model.id,{...previous,id:model.id,name:previous?.name||model.id,type,source:previous?.source==='Manager deployment'?previous.source:previous?'Kaggle + Model API':'Model API',
      detail:previous?.detail||'Returned by the connected model API',status:'API reported',reported:true});
  }
  return [...models.values()];
}
export function selectDiscoveredModel(current,models) {
  const chat=models.filter(m=>m.type==='Chat');
  if(chat.some(m=>m.id===current))return current;
  return (chat.find(m=>m.reported)||chat[0])?.id||'';
}

export function managerModelList(snapshot,models=[]){const list=Array.isArray(snapshot?.models)&&snapshot.models.length?snapshot.models:Array.isArray(models)?models:[],alias=snapshot?.config?.model_alias;if(!snapshot?.run?.active&&validId(alias)&&!list.some(m=>m.id===alias))return [{id:alias,source:'manager_profile',notebook_ref:snapshot.config.kernel_ref,status:'next_session'},...list];return list;}
