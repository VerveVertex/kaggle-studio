import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceConnectionPatch,sharedModelService,resolveModelService,modelSelections} from '../web/src/connections.mjs';
test('paired services share the model relay without populating incompatible external overrides',()=>{
 const data={manager_url:'https://studio-abcdef123456.example.workers.dev',model_url:'https://studio-abcdef123456.example.workers.dev/v1',manager_key:'admin',model_key:'model'};
 const settings={...deviceConnectionPatch(data),imageUrl:'https://images.example.com/v1',imageKey:'external-image',videoUrl:'https://video.example.com',videoKey:'external-video'};
 assert.deepEqual(sharedModelService(settings),{url:data.model_url,key:'model'});
 for(const kind of ['Chat','Image','Video'])assert.deepEqual(resolveModelService(settings,kind,true),{url:data.model_url,key:'model'});
 assert.deepEqual(resolveModelService(settings,'Image'),{url:settings.imageUrl,key:'external-image'});
 assert.deepEqual(resolveModelService(settings,'Video'),{url:settings.videoUrl,key:'external-video'});
 assert.equal(deviceConnectionPatch(data).videoKey,undefined);
});
test('external URLs and malformed roots are not mislabeled as a shared deployment',()=>{
 const settings={managerUrl:'https://manager.example.net',modelUrl:'https://model.example.net/v1',modelKey:'key'};
 assert.equal(sharedModelService(settings),null);
 for(const managerUrl of ['http://manager.example.net','https://key@manager.example.net','https://manager.example.net/path','https://manager.example.net/?a=b'])assert.equal(sharedModelService({...settings,managerUrl,modelUrl:'https://manager.example.net/v1'}),null);
 assert.equal(sharedModelService({...settings,modelUrl:'https://manager.example.net/v1',modelKey:''}),null);
});
test('pairing immediately selects one registered model per type and preserves valid choices',()=>{
 const models=[{id:'chat',type:'chat'},{id:'image1',type:'image'},{id:'image2',type:'image'},{id:'video',type:'video'}];
 assert.deepEqual(modelSelections({},models),{modelId:'chat',imageModel:'image1',videoModel:'video'});
 assert.equal(modelSelections({imageModel:'image2'},models).imageModel,'image2');
});
