import React,{useEffect,useRef} from 'react';
import {Settings,Sun,Moon,Monitor,Languages} from 'lucide-react';

export default function DisplayPreferences({language='en',theme='system',onLanguage,onTheme}){
 const ref=useRef(null),zh=language==='zh-CN',t=(en,cn)=>zh?cn:en;
 useEffect(()=>{
  const outside=e=>{if(ref.current?.open&&!ref.current.contains(e.target))ref.current.open=false};
  const escape=e=>{if(e.key==='Escape'&&ref.current?.open){e.preventDefault();e.stopPropagation();ref.current.open=false;ref.current.querySelector('summary')?.focus()}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true)};
 },[]);
 return <details ref={ref} className="setup-preferences"><summary aria-label={t('Display and language','显示与语言')} title={t('Display and language','显示与语言')}><Settings size={21}/></summary><div className="setup-preferences-panel" role="group" aria-label={t('Display and language','显示与语言')}><h3>{t('Display and language','显示与语言')}</h3><label className="field"><span><Sun size={15}/>{t('Appearance','外观')}</span><select aria-label={t('Appearance','外观')} value={theme} onChange={e=>onTheme?.(e.target.value)}><option value="light">{t('Light','浅色')}</option><option value="dark">{t('Dark','深色')}</option><option value="system">{t('Follow system','跟随系统')}</option></select></label><label className="field"><span><Languages size={15}/>{t('Language','语言')}</span><select aria-label={t('Language','语言')} value={language} onChange={e=>onLanguage?.(e.target.value)}><option value="en" lang="en">English</option><option value="zh-CN" lang="zh-CN">中文（简体）</option></select></label><p>{theme==='system'?t('Appearance follows your device.','外观随设备系统设置切换。'):t('Saved on this device. Sign-in is not required.','设置保存在此设备，无需登录。')}</p></div></details>;
}
