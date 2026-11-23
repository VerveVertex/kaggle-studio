import {deploymentModels,publicCatalog,profileConfig} from '../../shared/catalog.mjs';
export async function selectedProfile(env,cfg){
 const models=deploymentModels(cfg);let id;
 try{id=(await env.DB.prepare("SELECT value FROM studio_options WHERE name='selected_model'").first())?.value}catch{}
 return models.find(p=>p.id===id)||models.find(p=>p.id===cfg.model_alias)||models[0];
}
export async function saveSelection(env,cfg,id){const model=deploymentModels(cfg).find(p=>p.id===id);if(!model)throw Object.assign(Error('Select a model deployed in this manager.'),{status:400});
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_options(name TEXT PRIMARY KEY,value TEXT NOT NULL)').run();await env.DB.prepare("INSERT INTO studio_options(name,value) VALUES ('selected_model',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").bind(id).run();return model;
}
export async function runModel(env,run,cfg){if(!run)return null;try{return (await env.DB.prepare('SELECT model_id FROM studio_run_models WHERE run_id=?').bind(run.id).first())?.model_id||cfg.model_alias}catch{return cfg.model_alias}}
export async function recordModel(env,id,model){await env.DB.prepare('CREATE TABLE IF NOT EXISTS studio_run_models(run_id TEXT PRIMARY KEY,model_id TEXT NOT NULL)').run();await env.DB.prepare('INSERT INTO studio_run_models(run_id,model_id) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET model_id=excluded.model_id').bind(id,model).run()}
export {deploymentModels,publicCatalog,profileConfig};

export async function runSupportsJobs(env,run){if(!run?.active)return true;try{return !!await env.DB.prepare('SELECT model_id FROM studio_run_models WHERE run_id=?').bind(run.id).first()}catch{return false}}
