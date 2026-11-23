import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePairStart,validatePairResult,managerOrigin} from '../web/src/pairing.mjs';
const base='https://gpu.example.com',id='a'.repeat(64);
const start={id,authorize_url:base+'/connect/login?id='+id,confirmation_code:'AAAAAAAA',expires_at:1234};
const result={status:'connected',manager_url:base,model_url:base+'/v1',manager_key:'studio_admin_'+'b'.repeat(64),model_key:'studio_model_'+'c'.repeat(64),expires_at:1234};
test('pairing links stay on the selected manager and must match the initiating state',()=>{
 assert.equal(managerOrigin(base+'/'),base);assert.equal(validatePairStart(base,start),start);
 for(const invalid of [{authorize_url:'https://evil.example/connect/login?id='+id},{authorize_url:base+'/connect/login?id=other'},{confirmation_code:'BAD'},{authorize_url:'https://u:p@gpu.example.com/connect/login?id='+id}])assert.throws(()=>validatePairStart(base,{...start,...invalid}));
 assert.throws(()=>managerOrigin(base+'/v1'));assert.throws(()=>managerOrigin('http://gpu.example.com'));
});
test('the app accepts only separate device credentials for the same manager and model proxy',()=>{
 assert.equal(validatePairResult(base,result),result);
 for(const invalid of [{model_url:'https://evil.example/v1'},{manager_url:base+'/other'},{model_key:result.manager_key},{manager_key:'some-cloudflare-api-token'},{status:'pending'}])assert.throws(()=>validatePairResult(base,{...result,...invalid}));
});
