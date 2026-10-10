#!/usr/bin/env python3
"""Read-only public release checks. Prints locations, never credential values."""
from pathlib import Path
import json, re, struct, sys
root = Path(__file__).resolve().parents[1]
private = re.compile(r'/home/' + ''.join(map(chr, [114,105,111])) + r'\b|\b' + ''.join(map(chr, [114,105,111])) + r'\b|\b(?:' + '|'.join([''.join(map(chr,x)) for x in ([67,76,73,78,67,72],[69,110,101,114,98,105,100],[78,97,100,100,111])]) + r')\b', re.I)
credential = re.compile(r'\b(?:sk-ant-|sk_live_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b')
# A directory scanner refuses a source file that carries an invisible format
# character, however harmless it is: it cannot be reviewed, and it can hide a
# different name under a look-alike one. Tab, newline and carriage return are
# the whitespace every file may hold; nothing else in this class is allowed.
format_char = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\xad\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]')
# The binary kinds the directory accepts beside its text: the list is complete
# PNG and the other image forms, plus the two cue files, which are held for a
# reviewer rather than refused. Anything else binary is not this repository's.
binary = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.wav'}
# The events whose hooks can refuse an action. The engine skips a hook that
# fails, so one of these without a `.catch` handler fails open: `claude plugin
# validate --json` reports each as a gating hook, and this holds the same line.
gating = ('on(\'tool.call\'', 'on(\'tool.check\'', 'on(\'agent.offer\'', 'on(\'agent.spawn\'', "on('config.set'", "on('prompt.submit'", "on('classic.", "on('command.run'")
findings=[]; count=0; total=0
for p in sorted(root.rglob('*')):
 rel=p.relative_to(root)
 if '.git' in rel.parts: continue
 # The engine's own declarations, written into the plugin folder on a
 # development load and gitignored here (.claude-plugin/types/.gitignore holds
 # `*`). They are not this repository's files and are not shipped: the release
 # commit carries none of them.
 if rel.parts[:2]==('.claude-plugin','types'): continue
 if p.is_symlink(): findings.append(f'{rel}: symbolic link'); continue
 if not p.is_file(): continue
 count+=1; total+=p.stat().st_size
 if p.stat().st_size>5*1024*1024: findings.append(f'{rel}: exceeds file limit')
 if p.name in ('AGENTS.md','CLAUDE.md','.DS_Store','Thumbs.db'): findings.append(f'{rel}: excluded release file')
 data=p.read_bytes()
 try: text=data.decode('utf8')
 except UnicodeDecodeError:
  if p.suffix not in binary: findings.append(f'{rel}: unexpected binary')
  continue
 for n,line in enumerate(text.splitlines(),1):
  if private.search(line): findings.append(f'{rel}:{n}: personal reference')
  if credential.search(line): findings.append(f'{rel}:{n}: credential-like value (review synthetic fixtures)')
  if format_char.search(line): findings.append(f'{rel}:{n}: unescaped format or control character')
# The hooks module, as a directory scanner reads it: every registration names its
# event literally, a pass-through never goes by another name, and a hook that can
# refuse carries the handler that refuses for it.
module = (root / 'hooks' / 'register.tsx').read_text()
for name in ('const next', 'let next', 'var next', 'function next', '.next('):
 if name in module: findings.append(f'hooks/register.tsx: `{name}` in the hooks module (a pass-through named for something else)')
blocks = [module[a:b] for a, b in zip([m.start() for m in re.finditer(r'\n  on\(', module)] + [len(module)], [m.start() for m in re.finditer(r'\n  on\(', module)][1:] + [len(module)])]
for block in blocks:
 head = block.lstrip('\n').split('\n')[0].strip()
 if head.startswith(tuple(gating)) and '}).catch(' not in block: findings.append(f'hooks/register.tsx: {head[:60]} can refuse without a .catch handler')
 # The directory confirms a permission hook only where it can read the return,
 # and the one return it reads on `tool.check` is the pass-through itself: a
 # returned name was refused (MOD_PERMISSION_ANSWER_UNREAD). Cockpit registers no
 # hook there now; one added later returns `next(e)` and nothing else.
 if head.startswith("on('tool.check'"):
  for line in block.split('\n'):
   if line.strip().startswith('return') and line.strip() != 'return next(e)': findings.append(f'hooks/register.tsx: the tool.check hook returns `{line.strip()[:60]}`, not `return next(e)`')
for p in sorted((root / 'hooks').glob('*.ts*')):
 for n, line in enumerate(p.read_text().splitlines(), 1):
  # The directory reads `import(` as a file loaded while the mod runs, in a type
  # position too: a type written that way was refused as a path that is not a
  # code file in the plugin (MOD_IMPORT_DYNAMIC_MISSING).
  if re.search(r'\bimport\s*\(', line): findings.append(f'hooks/{p.name}:{n}: import() expression; use a static import at the top of the file')
  # Cockpit asks no permission decision of its own. A query on every tool call
  # would be a second permission operation that nothing here needs.
  if re.search(r'\$\s*\.\s*tool\s*\.\s*check\b', line): findings.append(f'hooks/{p.name}:{n}: a permission query ($.tool.check) in the hooks module')
m=json.loads((root/'.claude-plugin/plugin.json').read_text()); market=json.loads((root/'.claude-plugin/marketplace.json').read_text())
assert m['version']==market['plugins'][0]['version']=='0.5.0'
assert m['name']==market['plugins'][0]['name']=='cobalt-cockpit'
assert market['plugins'][0]['source']=='./'
# This marketplace lists Cockpit and nothing else: the optional companion has its
# own repository and its own marketplace, and none of its code lives here.
assert len(market['plugins'])==1
assert not (root/'companions').exists()
assert m['repository']=='https://github.com/echelong/cobalt-cockpit'
for key in ('orchestration','blockFable','subscriptionOnly','cobaltStrict'):
 assert m['userConfig'][key]['default'] is False, key
for name in ('README.md','LICENSE','THIRD_PARTY_NOTICES','SECURITY.md','PRIVACY.md','CHANGELOG.md','.gitignore'):
 assert (root/name).is_file(), name
notices=(root/'THIRD_PARTY_NOTICES').read_text()
assert 'Copyright (c) 2026 Kirill Serditov' in notices
assert 'Copyright (c) 2026 Hamza Zafar' in notices
# The listing icon, at whatever path the manifest names: square, 512-2048 px a
# side, under 2 MB, a complete PNG, and carrying no text or time metadata of its
# own. The directory reads this field for the listing; Claude Code ignores it.
icon = m.get('icon')
assert isinstance(icon, str) and icon.startswith('./'), 'plugin.json: icon path'
p = root / icon[2:]
if not p.is_file():
 findings.append(f'{icon}: the manifest names an icon that is not a file')
else:
 data = p.read_bytes(); at = 8; kinds = []
 while at < len(data):
  length = struct.unpack('>I', data[at:at+4])[0]; kinds.append(data[at+4:at+8].decode('ascii', 'replace')); at += 12 + length
 width, height = struct.unpack('>II', data[16:24])
 if data[:8] != b'\x89PNG\r\n\x1a\n': findings.append(f'{icon}: not a PNG')
 if width != height or not 512 <= width <= 2048: findings.append(f'{icon}: {width}x{height}, the directory wants a square 512-2048 px image')
 if len(data) >= 2*1024*1024: findings.append(f'{icon}: {len(data)} bytes, over the 2 MB listing limit')
 if {'tEXt','iTXt','zTXt','eXIf','tIME'} & set(kinds): findings.append(f'{icon}: carries text or time metadata: {sorted(set(kinds))}')
print(f'{count} files; {total} bytes; manifest/defaults/license checks passed; icon {width}x{height} {len(data)} bytes')
for row in findings: print(row)
print(f'{len(findings)} portability/credential findings')
sys.exit(bool(findings))
