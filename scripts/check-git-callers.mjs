// v0.6.6: the census of every process Cockpit starts and every Git command it runs, read from the source text, against the
// checked-in record scripts/git-callers.json. A new process site, a new `bounded` call, or a new call of a closure that runs
// Git changes the census and fails this check until the record is regenerated (--write) and the difference reviewed. It also
// holds the invariants the runtime admission rests on:
//   - only register.tsx starts processes, at exactly the recorded sites; there is no $.process.spawn;
//   - every `bounded` call starts one of the measurement programs (BOUND_PROGRAMS in hooks/git-integrity.ts);
//   - a repository-state pass is created in one place only (repoState), and `auth` is only ever a pass or the preflight's own
//     listing capability, never a value built from a string;
//   - the helper's environment check reads exactly GIT_ENV_REFUSED, by literal name, in order.
// Plugin tests cannot read source files (the test runtime imports only the plugin's own modules), so this is a script, run by CI.
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

const hooks = readdirSync(resolve(root, 'hooks')).filter(f => /\.tsx?$/.test(f)).map(f => `hooks/${f}`)
const processSites = []
for (const file of hooks) {
  const lines = read(file).split('\n'), who = owners(lines)
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\$\.process\.(run|spawn)\(/g)) {
      if (m[1] === 'spawn') problems.push(`${file}:${i + 1}: $.process.spawn is not used anywhere in Cockpit`)
      const after = line.slice(m.index + m[0].length)
      processSites.push({ file, function: who[i], program: firstLiteral(after) ?? after.slice(0, after.search(/[(,\]]/)).replace(/^\[/, '').trim() })
    }
  })
}
for (const site of processSites) if (site.file !== 'hooks/register.tsx') problems.push(`${site.file}: starts a process; only hooks/register.tsx may`)

const integrity = read('hooks/git-integrity.ts')
const PROGRAMS = JSON.parse(/BOUND_PROGRAMS: readonly string\[\] = (\[[^\]]*\])/.exec(integrity)[1].replace(/'/g, '"'))
const ENV_REFUSED = [...(/GIT_ENV_REFUSED: readonly string\[\] = \[([\s\S]*?)\]/.exec(integrity)[1].matchAll(/'([A-Z0-9_]+)'/g))].map(m => m[1])

const text = read('hooks/register.tsx'), lines = text.split('\n'), who = owners(lines)
// `bounded` calls, and the closures over `bounded` each function defines (a `const` whose line, or the next two, call it)
const bounded = [], closures = new Map()
lines.forEach((line, i) => {
  const call = line.indexOf('bounded($,')
  if (call < 0) return
  const program = firstLiteral(line.slice(call + 'bounded($,'.length))
  if (program === null || !PROGRAMS.includes(program)) problems.push(`hooks/register.tsx:${i + 1}: bounded() starts ${program ?? 'a program not given as a literal'}, not one of ${PROGRAMS.join(', ')}`)
  const sub = program === 'git' ? (/'-C', [^,]+, '([^']+)'/.exec(line) ?? /\.\.\.GIT_SAFE, '([^']+)'/.exec(line) ?? /\['git', '([^']+)'/.exec(line))?.[1] ?? '(closure)' : '-'
  bounded.push({ function: who[i], program, sub })
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
    const body = lines.slice(i, i + 3).join('\n')
    if ([...names].some(n => new RegExp(`(?<![\\w.])${n}\\(`).test(body.slice(body.indexOf('=>'))))) { names.add(def[1]); grew = true }
  })
}
const closureCalls = []
lines.forEach((line, i) => {
  const names = closures.get(who[i])
  if (names === undefined) return
  for (const name of names) for (const m of line.matchAll(new RegExp(`(?<![\\w.])${name}\\((\\[)?\\s*'([^']+)'(?:, '([^']+)')?`, 'g'))) {
    if (line.includes(`const ${name} =`)) continue
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
const envStart = lines.findIndex(l => l.startsWith('const gitEnvironmentSet'))
const envNames = envStart < 0 ? [] : [...lines.slice(envStart, envStart + 12).join('\n').matchAll(/\$\.env\.get\('([A-Z0-9_]+)'\)/g)].map(m => m[1])
if (JSON.stringify(envNames) !== JSON.stringify(ENV_REFUSED)) problems.push(`gitEnvironmentSet reads ${envNames.join(',')}; GIT_ENV_REFUSED is ${ENV_REFUSED.join(',')}`)

const count = rows => Object.entries(rows.reduce((m, r) => { const k = JSON.stringify(r); m[k] = (m[k] ?? 0) + 1; return m }, {})).map(([k, n]) => ({ ...JSON.parse(k), count: n })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
const census = { processSites: count(processSites), bounded: count(bounded), closureCalls: count(closureCalls) }
if (processSites.length !== 11) problems.push(`expected 11 process sites, found ${processSites.length}`)

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
