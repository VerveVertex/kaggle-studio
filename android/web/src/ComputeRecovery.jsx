import React,{useEffect,useRef,useState} from 'react';
import {copyText} from './native.mjs';
import {jsonBridge} from './services.js';
import {managerNeedsRepair} from './manager-version.mjs';
import publisher from './setup/publisher.json';
export default function ComputeRecovery({settings,manager,managerError,onRepair,onRefresh,onConfirmed,disabled=false}){
 const zh=settings.language==='zh-CN',t=(a,b)=>zh?b:a;
 const [health,setHealth]=useState(null),[report,setReport]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState(null),[ack,setAck]=useState(false);const working=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
 const url=settings.managerUrl,key=settings.managerKey,run=manager?.run,version=manager?.build||health?.build,old=managerNeedsRepair(version,publisher.minimumManagerBuild);
 useEffect(()=>{let live=true;setHealth(null);setReport(null);if(url&&key)jsonBridge('manager_health',url,key).then(b=>{if(live)setHealth(b)}).catch(()=>{});return()=>{live=false}},[url,key]);
 const clean=value=>{let s=String(value||'');for(const secret of [settings.managerKey,settings.modelKey])if(secret)s=s.split(secret).join('[redacted]');return s.replace(/KGAT_[A-Za-z0-9_.-]+/g,'[redacted]').replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [redacted]').slice(0,1000)};
 async function task(fn){if(working.current)return;working.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError(clean(e.message))}finally{working.current=false;setBusy(false)}}
 async function diagnose(){await task(async()=>{const data=await jsonBridge('manager_diagnostics',url,key);setReport({manager_url:url,notebook:clean(data.kernel_ref||manager?.config?.kernel_ref),run_id:run?.id||null,status_error:clean(managerError),checks:(Array.isArray(data.checks)?data.checks:[]).map(c=>({check:clean(c.check),ok:c.ok===true,state:clean(c.state),error:clean(c.error)}))})})}
 async function confirmEnded(){await task(async()=>{
  if(!ack||!confirmation?.id)throw Error(t('Confirm that this notebook is no longer queued or running.','请先确认对应 Notebook 已不再排队或运行。'));
  const current=await jsonBridge('manager_status',url,key);
  if(current.run?.id!==confirmation.id)throw Error(t('The run changed. Check Kaggle again.','会话已经变化，请重新核实 Kaggle。'));
  let ended=current.run;if(current.run.active&&!current.run.ended)ended=(await jsonBridge('manager_manual_ended',url,key,{confirm:'I_STOPPED_IN_KAGGLE',run_id:confirmation.id})).run;
  if(!alive.current)return;if(ended)onConfirmed?.(ended);await onRefresh();setConfirmation(null);setAck(false);
 })}
 if(!url||!key)return null;
 return <div className="compute-recovery">
  {old&&<div className="notice upgrade-notice"><strong>{t('Cloud manager update has not taken effect','云端管理端修复尚未生效')}</strong><p>{t('Installing an APK does not update the Worker. Authorize Cloudflare and choose “Repair manager program only”; no Kaggle token is needed.','安装 APK 不会同步更新 Worker。请授权 Cloudflare 后选择“仅修复管理程序”，无需填写 Kaggle Token。')}</p><button className="primary" disabled={disabled||busy} onClick={onRepair}>{t('Repair manager','修复管理端')}</button></div>}
  {managerError&&run?.active&&<p className="hint" role="status">{t('The session end is unconfirmed because the status query failed. This does not prove the GPU is still running.','状态查询失败，目前尚未核实会话结束；这不代表 GPU 仍在运行。')}</p>}
  <div className="form-actions"><button className="secondary" disabled={disabled||busy} onClick={diagnose}>{t('Check connection diagnostics','查看连接诊断')}</button>{run?.active&&(run.stop||run.stale||managerError)&&<button className="secondary" disabled={disabled||busy} onClick={()=>{setConfirmation({id:run.id,ref:manager.notebook_ref||manager.config?.kernel_ref});setAck(false);setError('')}}>{t('I already stopped it on Kaggle','我已在 Kaggle 停止')}</button>}</div>
  {confirmation&&<div className="notice manual-end-confirmation" role="alertdialog" aria-label={t('Confirm Kaggle session ended','确认 Kaggle 会话已结束')}><strong>{t('Confirm the actual Kaggle session','核实 Kaggle 实际会话')}</strong><p className="setup-address">{confirmation.ref}</p><p>{t('This only releases the manager record. It does not stop a GPU. Open Kaggle and confirm the notebook is neither queued nor running before continuing.','此操作只解除管理端记录的锁定，不会停止 GPU。请先在 Kaggle 核实对应 Notebook 已不再排队或运行。')}</p><a className="text-action" target="_blank" rel="noreferrer" href="https://www.kaggle.com/code">{t('Open my Kaggle notebooks','打开 Kaggle Notebook 列表')} ↗</a><label className="confirmation-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/><span>{t('I checked Kaggle: this notebook is no longer queued or running.','我已检查 Kaggle，确认此 Notebook 已不再排队或运行。')}</span></label><div className="form-actions"><button className="secondary" disabled={busy} onClick={()=>setConfirmation(null)}>{t('Cancel','取消')}</button><button className="primary" disabled={!ack||busy} onClick={confirmEnded}>{t('Confirm ended and refresh','确认已结束并刷新')}</button></div></div>}
  {report&&<details className="diagnostic-details" open><summary>{t('Read-only diagnostics (no keys)','只读诊断（不含密钥）')}</summary><pre>{JSON.stringify(report,null,2)}</pre><button className="secondary" onClick={()=>task(async()=>copyText(JSON.stringify(report,null,2)))} disabled={busy}>{t('Copy diagnostics','复制诊断')}</button></details>}
  {error&&<p className="error-text" role="alert">{error}</p>}
 </div>;
}
