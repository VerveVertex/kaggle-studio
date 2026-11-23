#!/usr/bin/env python3
"""Offline APK compilation with official Android tools, Java and Eclipse ECJ."""
import argparse,hashlib,os,secrets,shutil,subprocess,zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--platform',required=True,help='Android 35 android.jar')
parser.add_argument('--tools',required=True,help='Android build-tools directory')
parser.add_argument('--ecj',required=True,help='Eclipse Java compiler JAR')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
platform=Path(args.platform).resolve();tools=Path(args.tools).resolve();ecj=Path(args.ecj).resolve()
out=root/'build';shutil.rmtree(out,ignore_errors=True);out.mkdir();(out/'classes').mkdir();(out/'dex').mkdir()
def run(command,**kwargs): subprocess.run([str(x) for x in command],check=True,**kwargs)
res=root/'app/src/main/res';assets=root/'app/src/main/assets'
if not (assets/'site/index.html').exists():raise SystemExit('Build the web UI first (cd web && npm ci && npx vite build).')
for name in ['aapt2','zipalign']:(tools/name).chmod(0o755)
run([tools/'aapt2','compile','--dir',res,'-o',out/'res.zip'])
ET.register_namespace('android','http://schemas.android.com/apk/res/android')
manifest=ET.parse(root/'app/src/main/AndroidManifest.xml');manifest.getroot().set('package','dev.wenyu.kagglestudio')
manifest.write(out/'AndroidManifest.xml',encoding='utf-8',xml_declaration=True)
run([tools/'aapt2','link','-I',platform,'--manifest',out/'AndroidManifest.xml',
     '-R',out/'res.zip','-A',assets,'--min-sdk-version','26','--target-sdk-version','35',
     '--version-code','17','--version-name','0.3.0','--auto-add-overlay','-o',out/'base.apk'])
sources=sorted((root/'app/src/main/java').rglob('*.java'))
run(['java','-jar',ecj,'-source','1.8','-target','1.8','-bootclasspath',
     str(platform)+os.pathsep+str(tools/'core-lambda-stubs.jar'),'-d',out/'classes',*sources])
run(['java','-cp',tools/'lib/d8.jar','com.android.tools.r8.D8','--release','--min-api','26',
     '--lib',platform,'--output',out/'dex',*sorted((out/'classes').rglob('*.class'))])
with zipfile.ZipFile(out/'base.apk','a',zipfile.ZIP_DEFLATED) as archive:
    for f in (out/'dex').glob('*.dex'):archive.write(f,f.name)
run([tools/'zipalign','-f','4',out/'base.apk',out/'aligned.apk'])
signing=root/'signing';signing.mkdir(exist_ok=True)
key=signing/'studio-release.p12';password=signing/'password.txt'
if not password.exists():password.write_text(secrets.token_urlsafe(36));password.chmod(0o600)
env=os.environ.copy();env['STUDIO_STORE_PASSWORD']=password.read_text().strip()
if not key.exists():
    run(['keytool','-genkeypair','-keystore',key,'-storetype','PKCS12','-storepass:env','STUDIO_STORE_PASSWORD',
         '-keypass:env','STUDIO_STORE_PASSWORD','-alias','studio-release','-keyalg','RSA','-keysize','3072',
         '-validity','10000','-dname','CN=Kaggle Studio Android,O=Personal Studio,C=CN'],env=env)
    key.chmod(0o600)
target=root/'kaggle-studio-android-0.3.0.apk'
run(['java','-jar',tools/'lib/apksigner.jar','sign','--ks',key,'--ks-key-alias','studio-release',
     '--ks-pass','env:STUDIO_STORE_PASSWORD','--key-pass','env:STUDIO_STORE_PASSWORD',
     '--out',target,out/'aligned.apk'],env=env)
run(['java','-jar',tools/'lib/apksigner.jar','verify','--verbose','--print-certs',target])
print('APK:',target)
print('SHA256:',hashlib.sha256(target.read_bytes()).hexdigest())
