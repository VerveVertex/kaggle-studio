#!/usr/bin/env python3
"""Run local unit and virtual-DOM checks; does not contact user accounts or request GPUs."""
import subprocess,os
from pathlib import Path
root=Path(__file__).resolve().parents[1]
checks=[('Maintenance tests',['node','--test','tests/maintenance.test.mjs'],root),('Installer tests',['node','--test','tests/setup.test.mjs'],root),
 ('Manager tests',['node','--test',*[str(p.relative_to(root/'manager')) for p in sorted((root/'manager/tests').glob('*.test.js'))]],root/'manager'),
 ('Android JS tests',['node','--test',*[str(p.relative_to(root/'android')) for p in sorted((root/'android/tests').glob('*.test.mjs'))]],root/'android'),
 ('Runner tests',['python3','-m','unittest','discover','-s','tests','-p','test_*.py'],root/'manager'),
 ('Setup UI',['node','tests/ui-check.mjs'],root),
 ('Code repair UI',['node','tests/ui-code-repair.mjs'],root),
 ('Deployment management UI',['node','tests/ui-management.mjs'],root),
 ('Qwen3.8 model UI',['node','tests/ui-model38.mjs'],root),
 ('Authorization expiry UI',['node','tests/ui-auth-expiry.mjs'],root),
 ('Setup recovery UI',['node','tests/ui-setup-recovery.mjs'],root),
 ('Manual token UI',['node','tests/ui-manual-token.mjs'],root),
 ('Existing UI build',['node','scripts/prepare-ui.mjs'],root),
 ('Signed-out display settings UI',['node','tests/ui-display-preferences.mjs'],root),
 ('Unified model selector UI',['node','tests/ui-model-selection.mjs'],root),
 ('Math rendering UI',['node','tests/ui-math.mjs'],root),
 ('Model connections UI',['node','tests/ui-model-connections.mjs'],root),
 ('Reference image UI',['node','tests/ui-reference-images.mjs'],root),
 ('Messages and accent UI',['node','tests/ui-messages.mjs'],root),
 ('Photo UI',['node','tests/ui-photo.mjs'],root),
 ('Language UI',['node','tests/ui-language.mjs'],root),
 ('Pairing UI',['node','tests/ui-pairing.mjs'],root),
 ('Stop recovery UI',['node','tests/ui-stop-recovery.mjs'],root),
 ('Stop polling UI',['node','tests/ui-stop-polling.mjs'],root),
 ('Cleanup and timing UI',['node','tests/ui-cleanup-timing.mjs'],root)]
for name,command,cwd in checks:
 test_env=os.environ.copy()
 if command[0]=='node':test_env['NODE_OPTIONS']=(test_env.get('NODE_OPTIONS','')+' --import='+str(root/'tests/no-network.mjs')).strip()
 proc=subprocess.run(command,cwd=cwd,env=test_env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if proc.returncode:print(proc.stdout);raise SystemExit(name+' failed')
 summaries=[s for s in proc.stdout.splitlines() if s.startswith(('ℹ tests','ℹ pass','Ran ','OK','PASS:','UI passed:'))]
 print(name+': PASS'+(' | '+' / '.join(summaries) if summaries else ''))
