#!/usr/bin/env python3
"""Read-only public release checks. Prints locations, never credential values."""
from pathlib import Path
import json, re, sys
root = Path(__file__).resolve().parents[1]
private = re.compile(r'/home/' + ''.join(map(chr, [114,105,111])) + r'\b|\b' + ''.join(map(chr, [114,105,111])) + r'\b|\b(?:' + '|'.join([''.join(map(chr,x)) for x in ([67,76,73,78,67,72],[69,110,101,114,98,105,100],[78,97,100,100,111])]) + r')\b', re.I)
credential = re.compile(r'\b(?:sk-ant-|sk_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b')
findings=[]; count=0; total=0
for p in sorted(root.rglob('*')):
 rel=p.relative_to(root)
 if '.git' in rel.parts: continue
 if p.is_symlink(): findings.append(f'{rel}: symbolic link'); continue
 if not p.is_file(): continue
 count+=1; total+=p.stat().st_size
 if p.stat().st_size>5*1024*1024: findings.append(f'{rel}: exceeds file limit')
 if p.name in ('AGENTS.md','CLAUDE.md','.DS_Store','Thumbs.db'): findings.append(f'{rel}: excluded release file')
 data=p.read_bytes()
 try: text=data.decode('utf8')
 except UnicodeDecodeError:
  if p.suffix!='.wav': findings.append(f'{rel}: unexpected binary')
  continue
 for n,line in enumerate(text.splitlines(),1):
  if private.search(line): findings.append(f'{rel}:{n}: personal reference')
  if credential.search(line): findings.append(f'{rel}:{n}: credential-like value (review synthetic fixtures)')
m=json.loads((root/'.claude-plugin/plugin.json').read_text()); market=json.loads((root/'.claude-plugin/marketplace.json').read_text())
assert m['version']==market['plugins'][0]['version']=='0.3.0'
assert m['name']==market['plugins'][0]['name']=='cobalt-cockpit'
assert market['plugins'][0]['source']=='./'
assert m['repository']=='https://github.com/echelong/cobalt-cockpit'
for key in ('orchestration','blockFable','subscriptionOnly','cobaltStrict'):
 assert m['userConfig'][key]['default'] is False, key
for name in ('README.md','LICENSE','THIRD_PARTY_NOTICES','SECURITY.md','CHANGELOG.md','.gitignore'):
 assert (root/name).is_file(), name
notices=(root/'THIRD_PARTY_NOTICES').read_text()
assert 'Copyright (c) 2026 Kirill Serditov' in notices
assert 'Copyright (c) 2026 Hamza Zafar' in notices
print(f'{count} files; {total} bytes; manifest/defaults/license checks passed')
for row in findings: print(row)
print(f'{len(findings)} portability/credential findings')
sys.exit(bool(findings))
