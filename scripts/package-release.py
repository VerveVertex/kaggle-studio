#!/usr/bin/env python3
"""Create a reproducible source archive without signing keys, dependencies or old builds."""
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parents[1]
version='0.3.0'
output=root.parent/'deliverables'/f'kaggle-studio-auto-setup-{version}-source.zip'
files=[]
for name in ['README.md','README.en.md','NOTICE.md','SECURITY.md','.gitignore','package.json','package-lock.json','android/build.gradle','android/settings.gradle','android/app/build.gradle','android/web/package.json','android/web/package-lock.json','android/web/vite.config.js','android/web/index.html','manager/package.json','manager/package-lock.json','manager/config.json','manager/wrangler.toml','manager/schema.sql','manager/auth.sql','manager/installer.sql']:
 files.append(root/name)
for folder in ['shared','scripts','tests','docs','android/web/src','android/web/public','android/app/src/main/java','android/app/src/main/res','android/scripts','android/tests','manager/src','manager/notebook','manager/tests','manager/public','publisher/public','.github']:
 files.extend(p for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
files.append(root/'android/app/src/main/AndroidManifest.xml')
assert all(not any(x in p.relative_to(root).parts for x in ['signing','node_modules','build','test-build']) for p in files)
assert all(p.suffix not in ['.p12','.jks','.keystore','.apk','.idsig','.class','.pyc'] for p in files)
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for p in sorted(set(files)):
  info=zipfile.ZipInfo(f'kaggle-studio-auto-setup-{version}/'+str(p.relative_to(root)),date_time=(2026,11,21,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
  archive.writestr(info,p.read_bytes())
print(output)
print('Source files:',len(set(files)),'bytes:',output.stat().st_size)
