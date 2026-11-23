#!/usr/bin/env python3
"""Compile host-executable Java tests with the same ECJ/Android stubs used by the APK."""
import argparse,subprocess
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--platform',required=True);parser.add_argument('--tools',required=True);parser.add_argument('--ecj',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];out=root/'test-build'/'java';out.mkdir(parents=True,exist_ok=True)
sources=[root/'android/app/src/main/java/dev/wenyu/kagglestudio/OAuthLoopback.java',root/'android/app/src/main/java/dev/wenyu/kagglestudio/NetworkPolicy.java',root/'android/tests/java/OAuthLoopbackTest.java',root/'android/tests/NetworkPolicyTest.java']
import os
subprocess.run(['java','-jar',args.ecj,'-source','1.8','-target','1.8','-bootclasspath',args.platform+os.pathsep+str(Path(args.tools)/'core-lambda-stubs.jar'),'-d',str(out),*[str(s) for s in sources]],check=True)
for name in ['dev.wenyu.kagglestudio.OAuthLoopbackTest','NetworkPolicyTest']:subprocess.run(['java','-cp',str(out),name],check=True)
