// v0.6.6: the census of every process Cockpit starts and every Git command it runs, read from the source text, against the
// checked-in record scripts/git-callers.json. A new process site, a new `bounded` call, or a new call of a closure that runs
// Git changes the census and fails this check until the record is regenerated (--write) and the difference reviewed. It also
// holds the invariants the runtime admission rests on:
//   - only register.tsx starts processes, at exactly the recorded sites (10 since Stage B moved `realpath -m` into the runner); there is
//     no $.process.spawn, and the process capability is reached through no other name, member or bracket;
//   - every `bounded` call starts one of the measurement programs (BOUND_PROGRAMS in hooks/git-integrity.ts);
//   - a repository-state pass is created in one place only (repoState), and `auth` is only ever a pass or the preflight's own
//     listing capability, never a value built from a string;
//   - the helper's environment check reads exactly GIT_ENV_REFUSED, by literal name, in order;
//   - (Stage B) the two sites that start measurement processes and their probes start `/usr/bin/env -i` with the loader's
//     variables blanked, the measurement environment check reads exactly GIT_ENV_MEASURED in order, every one of those names is
//     also refused for helpers, and the clean base reads PATH, HOME and XDG_CONFIG_HOME and no other variable.
// Plugin tests cannot read source files (the test runtime imports only the plugin's own modules), so this is a script, run by CI.
// It reads text, not a syntax tree: it is a tripwire for review, and the runtime admission in `bounded` is the guard.
// Usage: node scripts/check-git-callers.mjs [--write]. Exit 0: matches. Exit 1: differences or a broken invariant. Exit 2: could not run.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const record = resolve(root, 'scripts/git-callers.json')
const write = process.argv.includes('--write')
const problems = []
const read = file => readFileSync(resolve(root, file), 'utf8')

/** The top-level declaration each line belongs to (column-0 `const`/`let`/`function`). */
const owners = lines => {
  let current = '(module)'
  return lines.map(line => {
    const m = /^(?:export )?(?:const|let|function|async function) (\w+)/.exec(line)
    if (m) current = m[1]
    return current
  })
}
const firstLiteral = text => { const m = /^\s*(?:[^'`[]*\?\s*)?\[\s*'([^']+)'/.exec(text); return m ? m[1] : null }

const hooks = readdirSync(resolve(root, 'hooks'), { recursive: true }).map(String).filter(f => /\.(?:tsx?|mjs|cjs|js)$/.test(f)).map(f => `hooks/${f}`)
const processSites = []
for (const file of hooks) {
  const text = read(file), lines = text.split('\n'), who = owners(lines)
  lines.forEach((line, i) => {
    // every mention of the process capability must be a direct call of `$.process.run(`: no alias, no optional or computed member,
    // no `.spawn`, no line break before the call
    for (const m of line.matchAll(/\$\s*\.\s*process\b(\s*\??\.\s*(\w+)\s*(<[^>]*>)?\s*(\()?)?/g)) {
      if (m[2] !== 'run' || m[3] !== undefined || m[4] === undefined || !line.includes('$.process.run(', m.index)) { problems.push(`${file}:${i + 1}: the process capability is used other than as a direct $.process.run( call`); continue }
      const after = line.slice(m.index + m[0].length)
      processSites.push({ file, function: who[i], program: firstLiteral(after) ?? after.slice(0, after.search(/[(,\]]/)).replace(/^\[/, '').trim() })
    }
    // other routes to a process or to code: none is used, and none may be (Stage B: `process` reached through another name or a bracket)
    for (const [pattern, what] of [[/(?<![\w$])(?!\$)[A-Za-z_]\w*\s*\.\s*process\s*\.\s*(?:run|spawn)\b/, 'the process capability through another binding'], [/\[\s*['"`]process['"`]\s*\]/, 'the process capability through a bracket'], [/\bchild_process\b|\bBun\.spawn|\bDeno\.(?:run|Command)\b/, 'a process API other than $.process'], [/\beval\s*\(|\bnew\s+Function\s*\(/, 'eval or new Function'], [/\bimport\s*\(/, 'a dynamic import()']]) {
      if (pattern.test(line.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''"))) problems.push(`${file}:${i + 1}: ${what}`)
    }
  })
}
for (const site of processSites) if (site.file !== 'hooks/register.tsx') problems.push(`${site.file}: starts a process; only hooks/register.tsx may`)

const integrity = read('hooks/git-integrity.ts')
const PROGRAMS = JSON.parse(/BOUND_PROGRAMS: readonly string\[\] = (\[[^\]]*\])/.exec(integrity)[1].replace(/'/g, '"'))
const ENV_REFUSED = [...(/GIT_ENV_REFUSED: readonly string\[\] = \[([\s\S]*?)\]/.exec(integrity)[1].matchAll(/'([A-Z0-9_]+)'/g))].map(m => m[1])
const ENV_MEASURED = [...(/GIT_ENV_MEASURED: readonly string\[\] = \[([\s\S]*?)\]/.exec(integrity)[1].matchAll(/'([A-Z0-9_]+)'/g))].map(m => m[1])

const text = read('hooks/register.tsx'), lines = text.split('\n'), who = owners(lines)
// `bounded` calls, and the closures over `bounded` each function defines (a `const` whose line, or the next two, call it)
const bounded = [], closures = new Map()
lines.forEach((line, i) => {
  if (/\bbounded\b/.test(line) && !/\bbounded\(\$,|\bconst bounded = |`bounded`|\bbounded\b[^(]*\/\/|^\s*(?:\/\/|\*|\/\*)/.test(line) && /\bbounded\s*\(/.test(line)) problems.push(`hooks/register.tsx:${i + 1}: bounded() called other than as bounded($, …)`)
  for (const callAt of [...line.matchAll(/\bbounded\(\$,/g)].map(m => m.index)) {
  const args = line.slice(callAt + 'bounded($,'.length)
  const head = args.slice(0, Math.max(0, args.search(/\],\s*\{|\]\)/)) + 1) || args
  const programs = [...head.matchAll(/\[\s*'([^']+)'/g)].map(m => m[1])
  if (programs.length === 0 || programs.some(p => !PROGRAMS.includes(p))) problems.push(`hooks/register.tsx:${i + 1}: bounded() starts ${programs.join(' or ') || 'a program not given as a literal'}, not one of ${PROGRAMS.join(', ')}`)
  const program = programs[0] ?? null
  const segment = line.slice(callAt)
  const sub = program === 'git' ? (/'-C', [^,]+, '([^']+)'/.exec(segment) ?? /\.\.\.GIT_SAFE, '([^']+)'/.exec(segment) ?? /\['git', '([^']+)'/.exec(segment))?.[1] ?? '(closure)' : '-'
  bounded.push({ function: who[i], program, sub })
  }
  if (!/\bbounded\(\$,/.test(line)) return
  for (let k = i; k >= Math.max(0, i - 2); k--) {
    const def = /const (\w+) = (?:async )?\(/.exec(lines[k])
    if (def && def[1] !== 'r') { const set = closures.get(who[i]) ?? new Set(); set.add(def[1]); closures.set(who[i], set); break }
  }
})
// closures over those closures too (`at` calls `sh`), until nothing new is found
for (let grew = true; grew;) {
  grew = false
  lines.forEach((line, i) => {
    const names = closures.get(who[i])
    const def = /const (\w+) = (?:async )?\(/.exec(line)
    if (names === undefined || def === null || names.has(def[1])) return
    // a one-line closure whose body calls a known one (multi-line closures over `bounded` are found by the first pass)
    if (!line.includes('=>')) return
    if ([...names].some(n => new RegExp(`(?<![\\w.])${n}\\(`).test(line.slice(line.indexOf('=>'))))) { names.add(def[1]); grew = true }
  })
}
const closureCalls = []
lines.forEach((line, i) => {
  const names = closures.get(who[i])
  if (names === undefined) return
  for (const name of names) for (const m of line.matchAll(new RegExp(`(?<![\\w.])${name}\\((\\[)?\\s*(?:'([^']+)'(?:, '([^']+)')?)?`, 'g'))) {
    if (line.includes(`const ${name} =`)) continue
    if (m[2] === undefined) { closureCalls.push({ function: who[i], closure: name, sub: '(computed arguments)' }); continue }
    let words = [m[2], m[3]].filter(Boolean)
    if (words[0] === '-C') { const after = /'-C', [^,]+, '([^']+)'(?:, '([^']+)')?/.exec(line.slice(m.index)); words = after ? [after[1], after[2]].filter(Boolean) : ['(after -C)'] }
    closureCalls.push({ function: who[i], closure: name, sub: words.join(' ') })
  }
})

// the pass and the preflight's capability: created and handed out only where intended
const adds = lines.flatMap((l, i) => (l.includes('repoPasses.add(') ? [who[i]] : []))
if (adds.length !== 1 || adds[0] !== 'repoState') problems.push(`repoPasses.add must occur once, in repoState; found in: ${adds.join(', ') || 'nowhere'}`)
const listingUses = new Set(lines.flatMap((l, i) => (/\bPREFLIGHT_LISTING\b/.test(l) ? [who[i]] : [])))
for (const f of listingUses) if (!['PREFLIGHT_LISTING', 'isRepoPass', 'admissionRefusal', 'repoState'].includes(f)) problems.push(`PREFLIGHT_LISTING used in ${f}`)
lines.forEach((l, i) => {
  // a type annotation (`auth: RepoPass | …`) is not a value
  for (const m of l.matchAll(/\bauth: ([^,}\s)]+)/g)) if (!/^[A-Z]/.test(m[1]) && !['pass', 'checked.pass', 'place.pass', 'state.pass'].includes(m[1]) && !(who[i] === 'RunInit' || who[i] === 'repoState')) problems.push(`hooks/register.tsx:${i + 1}: auth is ${m[1]}, not a pass`)
})
lines.forEach((l, i) => { if (/[{,]\s*auth\s*[,}]/.test(l) && !/\bauth\?:|auth: (?:Repo|Pre)/.test(l) && who[i] !== 'repoState' && who[i] !== 'bounded') problems.push(`hooks/register.tsx:${i + 1}: auth passed by shorthand outside repoState`) })
const envStart = lines.findIndex(l => l.startsWith('const gitEnvironmentSet'))
const envEnd = envStart < 0 ? -1 : lines.findIndex((l, k) => k > envStart && /^\s*\]\.map\(/.test(l))
const envNames = envStart < 0 || envEnd < 0 ? [] : [...lines.slice(envStart, envEnd + 1).join('\n').matchAll(/\$\.env\.get\('([A-Z0-9_]+)'\)/g)].map(m => m[1])
if (JSON.stringify(envNames) !== JSON.stringify(ENV_REFUSED)) problems.push(`gitEnvironmentSet reads ${envNames.join(',')}; GIT_ENV_REFUSED is ${ENV_REFUSED.join(',')}`)
// Stage B: the clean launch, read from the text of the two functions that start measurement processes and their probes
const body = name => { const at = lines.findIndex(l => l.startsWith(`const ${name} = `)); if (at < 0) return ''; const end = lines.findIndex((l, k) => k > at && /^(?:const|let|type|function|class) /.test(l)); return lines.slice(at, end < 0 ? undefined : end).join('\n') }
const runner = body('bounded'), probe = body('probeBound')
if (!/admissionRefusal\(argv, auth\) \?\? \(callerEnvAdmitted\(env\) \?/.test(runner)) problems.push('bounded does not refuse a caller\'s variables other than LC_ALL=C before anything starts')
// the filter check's mark: given only by gitFiltersReliable, and required by the admission for a command that applies filters
const marks = lines.flatMap((l, i) => (l.includes('filterChecked.add(') ? [who[i]] : []))
if (marks.length === 0 || marks.some(f => f !== 'gitFiltersReliable')) problems.push(`filterChecked.add must occur only in gitFiltersReliable; found in: ${marks.join(', ') || 'nowhere'}`)
if (!/!runsFilters\(call\) \|\| filterChecked\.has\(auth\)/.test(body('admissionRefusal'))) problems.push('admissionRefusal does not require the filter check\'s mark for a command that applies filters')
// the probe runs no program it found before the repository and owner checks: its first process after the lookup is the owner check
const probeText = body('probeBound')
const order = ['sh(RESOLVE_SCRIPT)', 'repositoriesAbove(', "run([statAt.path, '-L'", "run([idAt.path, '-u'])", 'sh(BOUND_PROBE_GROUP', 'sh(BOUND_PROBE_CONTROL'].map(w => probeText.indexOf(w))
if (order.some(at => at < 0) || order.some((at, k) => k > 0 && at < order[k - 1])) problems.push('probeBound does not look up, check the repository, check owners, run id, then the probes that start a found program, in that order')
if (!/const words = \[CLEAN_ENV, '-i', \.\.\.cleanAssignments\(launch\.base, env\), CLEAN_SHELL, '-c', boundScript\(/.test(runner) || !/\$\.process\.run\(words, \{ \.\.\.host, env: LOADER_BLANK \}\)/.test(runner)) problems.push('bounded does not start its process as /usr/bin/env -i <clean variables> /bin/sh with the loader blanked')
if (!/\$\.process\.run\(\[CLEAN_ENV, '-i', `PATH=\$\{clean\.base\.path\.join\(':'\)\}`, 'LC_ALL=C', \.\.\.words\], \{ timeoutMs: 5000, env: LOADER_BLANK \}\)/.test(probe)) problems.push('probeBound does not start its probes as /usr/bin/env -i PATH=<trusted> with the loader blanked')
const measuredStart = lines.findIndex(l => l.startsWith('const measuredEnvironmentSet'))
const measuredEnd = measuredStart < 0 ? -1 : lines.findIndex((l, k) => k > measuredStart && /^\s*\]\.map\(/.test(l))
const measuredNames = measuredStart < 0 || measuredEnd < 0 ? [] : [...lines.slice(measuredStart, measuredEnd + 1).join('\n').matchAll(/\$\.env\.get\('([A-Z0-9_]+)'\)/g)].map(m => m[1])
if (JSON.stringify(measuredNames) !== JSON.stringify(ENV_MEASURED)) problems.push(`measuredEnvironmentSet reads ${measuredNames.join(',')}; GIT_ENV_MEASURED is ${ENV_MEASURED.join(',')}`)
for (const name of ENV_MEASURED) if (!ENV_REFUSED.includes(name)) problems.push(`${name} refuses measurement but not helper inspection`)
const baseNames = [...body('cleanBaseOf').matchAll(/\$\.env\.get\('([A-Z0-9_]+)'\)/g)].map(m => m[1])
if (JSON.stringify(baseNames) !== JSON.stringify(['PATH', 'HOME', 'XDG_CONFIG_HOME'])) problems.push(`cleanBaseOf reads ${baseNames.join(',')}, not exactly PATH, HOME and XDG_CONFIG_HOME`)

const count = rows => Object.entries(rows.reduce((m, r) => { const k = JSON.stringify(r); m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([k, n]) => ({ ...JSON.parse(k), count: n })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const census = { processSites: count(processSites), bounded: count(bounded), closureCalls: count(closureCalls) }
if (processSites.length !== 10) problems.push(`expected 10 process sites, found ${processSites.length}`)

if (write) { writeFileSync(record, JSON.stringify(census, null, 2) + '\n'); console.log(`check-git-callers: wrote ${record}`) }
else {
  let held
  try { held = JSON.parse(readFileSync(record, 'utf8')) } catch (e) { console.error(`check-git-callers: cannot read ${record}: ${e.message}`); process.exit(2) }
  for (const part of Object.keys(census)) {
    const now = census[part].map(r => JSON.stringify(r)), was = (held[part] ?? []).map(r => JSON.stringify(r))
    for (const r of now.filter(x => !was.includes(x))) problems.push(`${part}: new or changed ${r}`)
    for (const r of was.filter(x => !now.includes(x))) problems.push(`${part}: missing ${r}`)
  }
}
if (problems.length) { for (const p of problems) console.log(`check-git-callers: ${p}`); process.exit(1) }
console.log(`check-git-callers: ${processSites.length} process sites, ${bounded.length} bounded calls, ${closureCalls.length} closure calls, all recorded; invariants hold`)
