import test from 'node:test';
import assert from 'node:assert/strict';
import {managerNeedsRepair} from '../web/src/manager-version.mjs';
test('public-release APK updates preserve compatibility with the working stop-state manager',()=>{
 for(const build of ['0.1.8','0.2.0-preview.1','0.2.0-preview.2','0.2.0-preview.3','0.2.0-preview.4','0.2.0-preview.5','0.2.0-preview.6','0.2.0-preview.7','0.2.0-preview.10','0.2.0','0.3.0-preview.1','0.3.0-preview.2','0.3.0-preview.3'])assert(managerNeedsRepair(build),build);
 for(const build of ['0.3.0','1.0.0'])assert(!managerNeedsRepair(build),build);
 assert(!managerNeedsRepair(undefined));assert(!managerNeedsRepair('unknown'));
});
