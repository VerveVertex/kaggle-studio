import React,{useState} from 'react';
import {Copy,Eye,EyeOff,LoaderCircle,Link} from 'lucide-react';
import {useT} from './locale.jsx';
import {sharedModelService} from './connections.mjs';

export default function ModelConnections({settings,onChange,onTest,onCopy,busy,connection}){
 const t=useT(),[reveal,setReveal]=useState(false),shared=sharedModelService(settings);
 const field=(name,label,placeholder,type='text')=><label className="field"><span>{t(label)}</span><input aria-label={t(label)} type={type} value={settings[name]||''} placeholder={t(placeholder)} onChange={e=>onChange(name,e.target.value)} autoComplete="off" spellCheck="false"/></label>;
 return <div className="connection-section model-connections">
  <h3><Link size={18}/>{t('Model services')}</h3>{shared&&<div className="service-types">{t('Chat')} · {t('Image')} · {t('Video')}</div>}
  <></>
  {field('modelUrl','Base URL','https://model.example.com/v1')}
  {field('modelKey','API key','Your model API key',reveal?'text':'password')}
  <div className="form-actions connection-copy-actions">
   <button className="secondary" disabled={!settings.modelUrl} onClick={()=>onCopy(settings.modelUrl)}><Copy size={14}/>{t('Copy address')}</button>
   <button className="secondary" disabled={!settings.modelKey} onClick={()=>onCopy(settings.modelKey)}><Copy size={14}/>{t('Copy API key')}</button>
   <button className="text-action" aria-pressed={reveal} disabled={!settings.modelKey} onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={14}/>:<Eye size={14}/>} {t(reveal?'Hide key':'Show key')}</button>
  </div>
  <div className="form-actions"><button className="secondary" disabled={!!busy||!settings.modelUrl||!settings.modelKey} onClick={onTest}>{busy==='test'&&<LoaderCircle size={14} className="spin"/>}{t('Test connection')}</button></div>
  {connection&&<p className={connection.startsWith('Connected')?'credential-notice':'error-text'} role="status">{t(connection)}</p>}
  <details className="external-service-settings"><summary>{t('External image and video services')}</summary>
   <></>
   {field('imageUrl','Image base URL','Leave blank to use Model API')}
   {field('imageKey','Image API key','Leave blank to use model key','password')}
   {field('videoUrl','H3 gateway URL','https://video.example.com')}
   {field('videoKey','Access password','Your notebook access password','password')}
   <></>
  </details>
 </div>;
}
