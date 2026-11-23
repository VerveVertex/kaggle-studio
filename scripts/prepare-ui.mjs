import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../android/web/package.json',import.meta.url));
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('../android/web/src/App.jsx',import.meta.url))],outfile:fileURLToPath(new URL('../test-build/app-test.mjs',import.meta.url)),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire as __studioRequire} from 'node:module';const require=__studioRequire(import.meta.url);"},external:['react','react/*','react-dom','react-dom/*'],jsx:'automatic'});
