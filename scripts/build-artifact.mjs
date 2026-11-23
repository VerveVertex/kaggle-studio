import {MEDIA_PROFILES} from '../shared/profiles.mjs';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),require=createRequire(new URL('../android/web/package.json',import.meta.url));
const {build}=require('esbuild');
const result=await build({entryPoints:[fileURLToPath(new URL('manager/src/worker.js',root))],bundle:true,write:false,format:'esm',loader:{'.py':'text'},
 plugins:[{name:'installation-config',setup(b){b.onLoad({filter:/config\.json$/},()=>({contents:'export default JSON.parse("__STUDIO_CONFIG_JSON__")',loader:'js'}));}}]});
const template=result.outputFiles[0].text;
if(template.split(JSON.stringify('__STUDIO_CONFIG_JSON__')).length!==2)throw Error('Missing or ambiguous configuration slot.');
const schema=(await Promise.all(['schema.sql','auth.sql','installer.sql'].map(p=>readFile(new URL('manager/'+p,root),'utf8')))).join('\n');
const config=JSON.parse(await readFile(new URL('manager/config.json',root),'utf8'));
for(const field of ['manager_url','kernel_ref','kernel_title','model_url','tunnel_mode'])delete config[field];
config.context_size=65536;
const repo='https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/c1869413dece09109e55b7dcc2c77ef382b0d0bd/';
const next={...config,dataset_sources:config.dataset_sources.slice(1),model_glob:'',mmproj_glob:'',model_alias:'qwen3.8-27b',context_size:262144,kv_cache_type:'q4_0',
 model_assets:{weights:{url:repo+'Qwen3.8-27B-Q4_K_M.gguf',size:19403684480,sha256:'d15d4b6de55f662ac40e867702d31afe738d032fa06b829b2b1a21a49d4a48ee'},
 vision:{url:repo+'mmproj-Qwen3.8-27B-Q8_0.gguf',size:629247008,sha256:'2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb'}}};
const profiles=[{id:'qwen-dual-t4-gguf-v1',kind:'chat',title:'Qwen3.6 35B-A3B · T4 ×2 · 64K',config:{...config,model_kind:'chat'}},{id:'qwen38-27b-t4-256k-v1',kind:'chat',title:'Qwen3.8 27B · T4 ×2 · 256K',config:{...next,model_kind:'chat'}},...MEDIA_PROFILES.map(p=>({id:p.id,kind:p.kind,title:p.title,experimental:p.experimental,config:{accelerator:config.accelerator,max_minutes:config.max_minutes,dataset_sources:[],context_size:65536,model_alias:p.alias,model_kind:p.kind,media_family:p.family,media_model:{repo:p.repo,revision:p.revision}}}))];
const artifact={protocol:1,version:'0.3.0',template,schema,sha256:createHash('sha256').update(template).digest('hex'),profiles};
await writeFile(new URL('android/web/src/setup/artifact.json',root),JSON.stringify(artifact));
console.log('Built deployable manager template:',artifact.version,artifact.sha256,'bytes:',Buffer.byteLength(template));
