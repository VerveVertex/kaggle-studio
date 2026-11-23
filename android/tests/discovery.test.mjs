import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,loadSettings,apiModelList,discoveredModels,selectDiscoveredModel} from '../web/src/discovery.mjs';
test('a new installation has no service addresses or model presets',()=>{
 const settings=loadSettings(null,{});
 for(const key of ['modelUrl','managerUrl','videoUrl','imageUrl','modelId','imageModel'])assert.equal(settings[key],'');
 assert.equal(defaults.connectionSchema,2);assert.deepEqual(discoveredModels(),[]);
});
test('the first APK bundled addresses are removed on upgrade before credentials were entered',()=>{
 const old=JSON.stringify({modelUrl:'https://legacy.example.com/v1',managerUrl:'https://legacy-manager.example.com',modelId:'old-preset',imageModel:'old-image',theme:'dark'});
 const settings=loadSettings(old,{});assert.equal(settings.modelUrl,'');assert.equal(settings.managerUrl,'');
 assert.equal(settings.modelId,'');assert.equal(settings.imageModel,'');assert.equal(settings.theme,'dark');
});
test('upgrade preserves authenticated connections and encrypted keys',()=>{
 const settings=loadSettings(JSON.stringify({modelUrl:'https://model.example.com/v1',managerUrl:'https://manager.example.com'}),{modelKey:'model-key',managerKey:'admin-key'});
 assert.equal(settings.modelUrl,'https://model.example.com/v1');assert.equal(settings.managerKey,'admin-key');
 const newer=loadSettings(JSON.stringify({...settings,modelId:'discovered-id'}),{modelKey:'model-key'});
 assert.equal(newer.modelId,'discovered-id');
});
test('model IDs come from data and retain the distinction between configuration and API reports',()=>{
 const models=discoveredModels([{id:'arbitrary-model-a'}],[{id:'arbitrary-model-a',source:'kaggle_notebook',notebook_ref:'owner/notebook'},{id:'offline-model',source:'kaggle_notebook'}]);
 assert.equal(models.length,2);assert.equal(models[0].source,'Kaggle + Model API');assert(models[0].reported);
 assert.equal(models[1].source,'Kaggle notebook');assert(!models[1].reported);assert.equal(models[1].status,'Configured');
 assert.equal(selectDiscoveredModel('',models),'arbitrary-model-a');assert.equal(selectDiscoveredModel('offline-model',models),'offline-model');
});
test('invalid endpoint records do not become model choices; image type is explicit',()=>{
 assert.deepEqual(apiModelList([null,{id:''},{id:'bad\nmodel'},{id:'valid'}]),[{id:'valid'}]);
 const data=discoveredModels([{id:'image-model',type:'image'}]);assert.equal(data[0].type,'Image');
 assert.equal(selectDiscoveredModel('',data),'');
});

test('an idle deployment with a changed profile exposes its next-session model without claiming it is serving',async()=>{const {managerModelList}=await import('../web/src/discovery.mjs');const models=managerModelList({config:{model_alias:'new-model',kernel_ref:'owner/project'},run:{active:0}},[{id:'old-model',source:'kaggle_notebook'}]);assert.equal(models[0].id,'new-model');assert.equal(models[0].source,'manager_profile');assert.equal(models[0].status,'next_session');assert.equal(models[1].id,'old-model');assert.equal(managerModelList({config:{model_alias:'future'},run:{active:1}},[{id:'serving'}]).length,1)});
