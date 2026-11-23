import test from 'node:test';
import assert from 'node:assert/strict';
import {languages,translate,normalizeLanguage,localeFor} from '../web/src/i18n.mjs';
import {loadSettings} from '../web/src/discovery.mjs';
test('language survives reload without changing connections, credentials or model selection',()=>{
 const preferences={connectionSchema:2,theme:'dark',modelUrl:'https://model.example.com/v1',managerUrl:'https://gpu.example.com',modelId:'custom/model-id',language:'zh-CN'};
 const keys={modelKey:'test-model-key',managerKey:'test-admin-key'};
 const saved=loadSettings(JSON.stringify(preferences),keys);
 for(const key of Object.keys(preferences))assert.equal(saved[key],preferences[key]);
 assert.equal(saved.modelKey,keys.modelKey);assert.equal(saved.managerKey,keys.managerKey);
 const english=loadSettings(JSON.stringify({...preferences,language:'en'}),keys);
 assert.deepEqual({...english,language:'zh-CN'},saved);
 assert.equal(loadSettings(JSON.stringify({connectionSchema:2}),keys).language,'en');
 assert.equal(normalizeLanguage('unsupported'),'en');assert.deepEqual(languages.map(v=>v.id),['en','zh-CN']);
});
test('interface feedback changes language while raw identifiers are preserved',()=>{
 for(const text of ['Settings','Language','Connections','Models','Start session','ready','Invalid API Key','Session requested. Model loading may take several minutes.']){
  assert.notEqual(translate('zh-CN',text),text);assert.equal(translate('en',text),text);
 }
 for(const value of ['owner/custom-model','https://model.example.com/v1','sk-sample-credential','你好，Hello!','An unknown backend detail'])assert.equal(translate('zh-CN',value),value);
 assert.equal(translate('zh-CN','Connected · 2 models reported'),'已连接 · 返回 2 个模型');
 assert.equal(translate('zh-CN','custom/model selected. Availability follows the connected service.'),'已选择 custom/model，是否可用取决于连接的服务。');
});
test('time units and dates follow the selected interface locale',()=>{
 assert.equal(translate('zh-CN','29.8 h'),'29.8 小时');assert.equal(translate('zh-CN','700 min'),'700 分钟');
 assert.equal(translate('zh-CN','Generated in 3s'),'耗时 3 秒');assert.equal(localeFor('en'),'en-US');assert.equal(localeFor('zh-CN'),'zh-CN');
});
test('discovery errors translate known detail and retain unknown diagnostics',()=>{
 assert.equal(translate('zh-CN','Kaggle notebook discovery is unavailable. Update the manager to version 0.1.4 or later. Invalid API Key'),'无法读取 Kaggle Notebook，请将管理端更新至 0.1.4 或更高版本。 API 密钥无效');
 assert.equal(translate('zh-CN','Model API: Invalid API Key'),'模型 API：API 密钥无效');
});
