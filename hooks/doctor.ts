// /cockpit doctor: what Cockpit can see about its own installation, its
// storage and the host, said plainly. Read-only: it changes no setting, sets no
// variable, makes no request and prints no secret, no credential and no value
// of any setting but the one prompt-cache TTL. Home directories are shown as ~.
// What the host does not tell a plugin is reported as UNKNOWN, not guessed.

import { withoutHomeName } from './paths'
import { RESTART_TEXT, recommendation, sourceText } from './cache'
import type { Agents, CacheReading } from './cache'

export type Install = { key: string; version: string | null; path: string | null }
export type DoctorFacts = {
  version: string
  root: string
  home: string | null
  host: string | null
  hostSupported: boolean | null
  profile: string
  orchestration: boolean
  reasoning: string
  router: string
  permissionMode: string | null
  /** The installed entries named cobalt-cockpit@…, or null when the install record could not be read. */
  installs: Install[] | null
  /** Keys such as cobalt-cockpit@cobalt that settings enable, or null when settings could not be read. */
  enabled: string[] | null
  /** Other Cockpit registrations seen while loading; the host does not list loaded plugins to a plugin, so this can only ever find a late one. */
  otherRegistrations: { root: string; provenance: string }[]
  telemetry: { enabled: boolean; dir: string | null; listed: { files: number; bytes: number } | null; writes: number; failures: number; permissions: 'unchecked' | 'verified' | 'unverified'; shed: number }
  cache: CacheReading
  agents: Agents
  stop: StopFacts
  /** v0.6.4: the limits working-tree measurement processes run under, as probed on this host. */
  measurement?: { enforced: boolean; text: string }
  /** v0.6.6: the Git measurement runs, and whether it documents its own switch for lazy fetching (2.45.0 and later); null when it could not be read. */
  gitVersion?: { version: string; lazyFetchSwitch: boolean } | null
  guard: { enabled: boolean; /** v0.5.9: incidents are recorded without being notified. */ recordOnly?: boolean; label: string; used: number; max: number; cooldownSec: number; repeat: boolean; sound: boolean; /** The transport diagnostics, already worded. */ transport: string[]; /** Priorities, notified kinds, quiet hours and active conditions, already worded. */ policy?: string[] }
}

export type StopFacts = {
  policy: 'OBSERVE' | 'ENFORCE'
  /** The script's file name only. */
  script: string | null
  pinned: boolean
  timeoutSec: number
  maxAttempts: number
  problems: string[]
  /** Whether this script's raw bytes are enrolled for this project, as words. */
  trust: string
  last: { outcome: string; exit: number | null; at: number } | null
}

type Level = 'OK' | 'WARN' | 'INFO'
const line = (level: Level, text: string): string => `  ${level.padEnd(4)} ${text}`
/** v0.6.6: what keeps measurement from fetching, for the Git found here. Informational: nothing depends on the version. */
export const gitVersionText = (git: { version: string; lazyFetchSwitch: boolean } | null): string => {
  const common = 'repositories with a submodule or a partial clone are not measured'
  if (git === null) return `Git version UNKNOWN; measurement never fetches (a protocol allow-list no transport matches), and ${common}`
  if (git.lazyFetchSwitch) return `Git ${git.version}: measurement never fetches (Git's own switch and a protocol allow-list no transport matches), and ${common}`

  return `Git ${git.version} is older than 2.45, whose own switch against lazy fetching it may lack; measurement never fetches (a protocol allow-list no transport matches), and ${common}`
}

/** A path for a diagnostic: relative to the session's own home where it is inside it, and otherwise whole but for a personal directory's name. */
export const shown = (path: string, home: string | null): string => (home !== null && home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : withoutHomeName(path))
const within = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent.replace(/\/+$/, '')}/`)

/** The installation checks, as findings (WARN is something the owner may want to act on). */
export const installFindings = (f: DoctorFacts): string[] => {
  const out: string[] = []
  const root = f.root
  const mine = f.installs?.find(i => i.path !== null && within(root, i.path)) ?? null
  const installedHere = mine !== null
  const dev = !installedHere && !/\/plugins\/(cache|marketplaces)\//.test(root)
  out.push(line('INFO', `running ${f.version} from ${shown(root, f.home)} · ${installedHere ? 'the installed copy' : dev ? 'a development / inline copy' : 'a plugin-directory copy'}`))
  if (f.installs === null) out.push(line('INFO', 'the install record could not be read, so installed copies are UNKNOWN'))
  else if (f.installs.length === 0) out.push(line('INFO', 'no installed cobalt-cockpit entry is recorded'))
  else for (const i of f.installs) out.push(line(i.version !== null && i.version !== f.version && installedHere && i === mine ? 'WARN' : 'INFO', `installed ${i.key} ${i.version ?? 'version UNKNOWN'}${i.path === null ? '' : ` at ${shown(i.path, f.home)}`}`))
  const installedEnabled = f.enabled ?? []
  if (dev && f.installs !== null && f.installs.length > 0 && installedEnabled.length > 0) out.push(line('WARN', 'a development copy is running while an installed Cockpit is also enabled: both may load and register the same commands and tools. Disable one, or start with the installed copy disabled for this session.'))
  if (f.installs !== null && f.installs.length > 1) out.push(line('WARN', `${f.installs.length} Cockpit installs are recorded; only one should be enabled.`))
  if (installedEnabled.length > 1) out.push(line('WARN', `${installedEnabled.length} Cockpit entries are enabled in settings (${installedEnabled.join(', ')}).`))
  for (const o of f.otherRegistrations) out.push(line('WARN', `another Cockpit registered after this one: ${o.provenance} at ${shown(o.root, f.home)}`))
  if (f.otherRegistrations.length === 0) out.push(line('INFO', 'a second Cockpit is detected only if it registers after this one; the host does not list loaded plugins to a plugin, so an earlier one is UNKNOWN'))

  return out
}

export const doctorText = (f: DoctorFacts): string => {
  const out: string[] = ['COBALT DOCTOR · read-only; nothing is changed', '', 'INSTALLATION']
  out.push(...installFindings(f))
  out.push('', 'PROFILE')
  out.push(line(f.orchestration ? 'OK' : 'INFO', `orchestration ${f.orchestration ? 'enforced' : 'observing only'} · profile ${f.profile} · reasoning ${f.reasoning} · router ${f.router}`))
  if (f.profile === 'SONNET_LED' && !f.orchestration) out.push(line('WARN', 'profile is SONNET_LED but orchestration is off, so the profile is not enforced'))
  out.push('', 'HOST')
  out.push(line(f.hostSupported === false ? 'WARN' : 'INFO', `Claude Code ${f.host ?? 'version UNKNOWN'}${f.hostSupported === false ? ' is older than this build supports; Cockpit stands by' : ''}`))
  out.push(line('INFO', `permission mode ${f.permissionMode ?? 'UNKNOWN (not yet seen on a tool call)'} · Cockpit never changes it`))
  if (f.measurement !== undefined) out.push(line(f.measurement.enforced ? 'OK' : 'WARN', f.measurement.text))
  // older or unknown Git: the partial-clone refusal and the protocol allow-list stand without Git's own lazy-fetch switch
  if (f.gitVersion !== undefined) out.push(line(f.gitVersion?.lazyFetchSwitch === true ? 'INFO' : 'WARN', gitVersionText(f.gitVersion)))
  out.push(line('INFO', 'Auto mode: the host classifier decides tool permissions. Cockpit adds no bypass; its own file and process calls are the plugin API\'s, and a refusal is recorded as unverified and not retried another way.'))
  out.push('', 'TELEMETRY')
  const t = f.telemetry
  if (!t.enabled) out.push(line('INFO', 'off (telemetry=false); nothing is recorded'))
  else {
    out.push(line(t.dir === null ? 'WARN' : 'OK', t.dir === null ? 'no absolute state or home directory is known, so nothing can be recorded' : `directory ${shown(t.dir, f.home)}`))
    out.push(line('INFO', t.listed === null ? 'directory not present or not readable yet' : `${t.listed.files} file${t.listed.files === 1 ? '' : 's'} · ${t.listed.bytes} bytes (bounded at 4 MiB; segments of 64 KiB; 13 months)`))
    out.push(line(t.failures > 0 ? 'WARN' : 'INFO', `this session: ${t.writes} written · ${t.failures} failed${t.shed > 0 ? ` · ${t.shed} old file${t.shed === 1 ? '' : 's'} removed` : ''}`))
    out.push(line(t.permissions === 'unverified' ? 'WARN' : 'INFO', t.permissions === 'verified' ? 'permissions read back: directory 0700, files 0600' : t.permissions === 'unverified' ? 'permissions NOT confirmed: the host gives plugins no file mode and the read-back failed or was refused; files are as private as your umask' : 'permissions not checked yet (nothing written this session)'))
    out.push(line('INFO', 'storage is not append-only: each process rewrites its own bounded segment; no two processes write one file'))
  }
  out.push('', 'SUBAGENT PROMPT CACHE · configuration intent, not observed behaviour')
  const c = f.cache
  out.push(line(c.supported === false ? 'WARN' : 'INFO', `${c.supported === null ? 'support UNKNOWN' : c.supported ? 'supported' : 'not supported'} (needs Claude Code 2.1.242) · subagents ask for ${c.ttl === 'auto' ? 'the host default (5 minutes)' : c.ttl} · from ${sourceText(c)}`))
  for (const n of c.notes) out.push(line('WARN', n))
  out.push(line('INFO', 'per-agent cacheTtl in an agent file applies only when nothing above is set; Cockpit\'s agents set none; other plugins\' agents are not read'))
  out.push(line('INFO', 'effective 5-minute / 1-hour behaviour: UNKNOWN (usage reports carry total cache writes, not the TTL split) — see /cockpit stats'))
  const advice = recommendation(c, f.agents)
  if (advice !== null) out.push(line('INFO', advice))
  out.push(line('INFO', RESTART_TEXT))
  out.push('', 'STOP-HOOK VERIFICATION GUARD')
  const g = f.stop
  if (g.policy === 'OBSERVE') {
    out.push(line('INFO', 'OBSERVE (default): nothing runs at Stop; no check, no block, no model call'))
    // a script named while the effective mode is OBSERVE: the host may have turned a value it did not accept into OBSERVE before the plugin saw it
    if (g.script !== null || g.problems.length > 0) out.push(line('WARN', 'Verification script configured, but Stop Guard is in OBSERVE mode. Verification is not enforced. Check your configured stopGuard value.'))
  } else {
    out.push(line(g.problems.length > 0 || g.script === null ? 'WARN' : 'OK', `ENFORCE · script ${g.script ?? 'NOT SET'} · ${g.pinned ? 'sha-256 pinned · ' : ''}trust: ${g.trust}${g.trust === 'enrolled' ? '' : ' (a person must run /cockpit guard trust)'} · timeout ${g.timeoutSec}s · ${g.maxAttempts} attempt${g.maxAttempts === 1 ? '' : 's'} per task`))
    for (const p of g.problems) out.push(line('WARN', p))
    out.push(line('INFO', g.last === null ? 'no check run yet this session' : `last check: ${g.last.outcome}${g.last.exit === null ? '' : ` (exit ${g.last.exit})`}`))
    out.push(line('INFO', 'a pass sets the TEST gate only; it does not clear a required Opus review or any release approval. Exhausted attempts, a missing, changed or refused script hold the task (BLOCKED, never DONE) and the stop is allowed; only a passing check or /cockpit guard release lifts the hold, and a release passes nothing.'))
  }
  out.push('', 'COBALT GUARD · owner alerts')
  out.push(line('INFO', f.guard.enabled ? `ARMED (${f.guard.label}) · ${f.guard.used} of ${f.guard.max} alerts used · one per ${f.guard.cooldownSec}s at most · delivery is the host's terminal notification; it cannot confirm that you saw it · persistent ${f.guard.repeat ? 'on' : 'off'} · sound ${f.guard.sound ? 'on' : 'off'}${f.guard.recordOnly ? ' · guardRecordOnly is also on and changes nothing while alerts are on' : ''}` : f.guard.recordOnly ? 'RECORDING (guardRecordOnly); incidents are written down for /cockpit alerts and nothing is sent: no notification, sound or bell' : 'OFF (guardAlerts=false, guardRecordOnly=false); nothing is sent and nothing new is recorded'))
  for (const row of f.guard.policy ?? []) out.push(row.startsWith('  WARN ') ? line('WARN', row.slice(7)) : line('INFO', row.trim()))
  for (const row of f.guard.transport) out.push(row.startsWith('  WARN ') ? line('WARN', row.slice(7)) : row.startsWith('  ') ? line('INFO', row.slice(2)) : line('INFO', row))
  out.push('', 'Cockpit edits no settings file and sets no variable; any cache change is yours to make.')

  return out.join('\n')
}
