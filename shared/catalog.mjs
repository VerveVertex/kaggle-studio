const KINDS=new Set(['chat','image','video']);
export function deploymentModels(config){
 const input=Array.isArray(config?.model_profiles)?config.model_profiles:[];
 const models=input.filter(p=>p&&typeof p.id==='string'&&/^[\w./-]{1,128}$/.test(p.id)&&KINDS.has(p.kind)&&p.config&&p.config.model_alias===p.id);
 if(models.length)return models.slice(0,12);
 return config?.model_alias?[{id:config.model_alias,kind:'chat',title:config.model_alias,config:{...config}}]:[];
}
export function publicCatalog(config,selected,active){return deploymentModels(config).map(p=>({id:p.id,type:p.kind,name:p.title||p.id,source:'manager_deployment',status:p.id===active?'ready':p.id===selected?'selected':'configured',reported:p.id===active,capabilities:{reference_image:p.kind==='chat'?!!(p.config.model_assets?.vision||p.config.mmproj_glob):['sdxl','zimage','wan22'].includes(p.config.media_family),image_to_image:p.kind==='image'&&['sdxl','zimage'].includes(p.config.media_family)}}));}
export function profileConfig(base,model){const p=model?.config||{};return {...base,...p,manager_url:base.manager_url,kernel_ref:base.kernel_ref,kernel_title:base.kernel_title,tunnel_mode:base.tunnel_mode,model_url:base.model_url,model_alias:model?.id||base.model_alias,model_kind:model?.kind||'chat'};}
