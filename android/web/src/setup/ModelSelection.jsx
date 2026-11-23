import React from 'react';
import {Check,MessageCircle,Image,Clapperboard,Plus} from 'lucide-react';

export default function ModelSelection({profiles,primary,enabled,onChange,disabled=false,language='en'}){
 const zh=language==='zh-CN',t=(en,cn)=>zh?cn:en,selected=new Set([primary,...enabled]);
 const list=[...profiles,{id:'custom-gguf-v1',kind:'chat',title:t('Custom GGUF model','自定义 GGUF 模型')}];
 const toggle=(id,checked)=>{
  const next=new Set(selected);if(checked)next.add(id);else next.delete(id);
  if(!next.size)return;
  const nextPrimary=next.has(primary)?primary:list.find(p=>next.has(p.id)).id;
  onChange({primary:nextPrimary,enabled:[...next].filter(id=>id!==nextPrimary)});
 };
 return <fieldset className="model-selection" aria-label={t('Deployment models','部署模型')} disabled={disabled}><legend>{t('Deployment models','部署模型')}</legend><></><div className="model-selection-list">{list.map(p=>{
  const chosen=selected.has(p.id),isDefault=primary===p.id,kind=p.kind||'chat',Icon=kind==='image'?Image:kind==='video'?Clapperboard:MessageCircle,name=p.title.split(' · ')[0];
  return <div className={'model-choice '+(isDefault?'is-default':'')} key={p.id} data-profile={p.id}><label className="model-choice-label"><input type="checkbox" data-profile-id={p.id} aria-label={t('Deploy ','部署 ')+name} checked={chosen} disabled={disabled||(isDefault&&selected.size===1)} onChange={e=>toggle(p.id,e.target.checked)}/><span><strong>{name}</strong><small><Icon size={13}/>{kind==='image'?t('Image','图片'):kind==='video'?t('Video','视频'):t('Chat','文字')}</small></span></label><button type="button" className="model-default" data-default-profile={p.id} aria-label={t('Default model: ','默认模型：')+name} aria-pressed={isDefault} disabled={disabled} onClick={()=>onChange({primary:p.id,enabled:[...selected].filter(id=>id!==p.id)})}>{isDefault?<><Check size={13}/>{t('Default','默认启动')}</>:t('Set default','设为默认')}</button></div>
 })}</div><></></fieldset>;
}
