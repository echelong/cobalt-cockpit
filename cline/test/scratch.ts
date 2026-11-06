// Scratch directories for the offline tests, removed when the test process ends, however it ends.
//
// Every test process gets ONE root per base directory (the system temporary directory, and HOME for canaries that
// must live on persistent storage no sandbox mounts): `ccl-run-<random>` (`.ccl-run-<random>` under HOME). Every
// fixture a test makes is created inside it, and so is anything the code under test puts in os.tmpdir() (the
// broker's socket directories), because TMPDIR is pointed at the root for this process and its children.
//
// The root is removed:
//   - when the process exits, after the tests pass or fail (an 'exit' handler, synchronous);
//   - on SIGINT, SIGTERM and SIGHUP (cancellation, and node --test ending a file that ran out of time): removed,
//     then the signal is raised again so the process still ends the way it was told to;
//   - otherwise (SIGKILL, a crash, a power cut) by the next test process, which sweeps roots whose owner is gone.
// A root is swept only when ALL of this holds: its name is `ccl-run-` (or `.ccl-run-`) plus mkdtemp's six characters,
// it is a real directory (not a link) owned by this user, it holds the owner record this module writes, the record
// names this exact path, and the process it names is not running (or that pid now belongs to a process that started
// at another time). Anything else, including every other file in those directories, is never touched.
// COCKPIT_TEST_KEEP=1 keeps this process's roots (for debugging a failure); they are still swept once their owner ends.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTimeOf } from '../src/proc.ts'

export const OWNER_FILE = '.ccl-owner.json'
const NAME = /^\.?ccl-run-[A-Za-z0-9]{6}$/
type Owner = { v: 1; pid: number; start: string | null; root: string }

/** Whether a root's owner has ended: no such process, or that pid was reused by a process with another start time. */
const ownerGone = (o: Owner): boolean => {
  try { process.kill(o.pid, 0) } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' }
  return o.start !== null && startTimeOf(o.pid) !== o.start
}

/** Why `path` must not be swept, or null when it is an abandoned root of these tests. */
export const sweepProblem = (path: string, name: string): string | null => {
  if (!NAME.test(name)) return 'not a test root name'
  let st; try { st = lstatSync(path) } catch { return 'gone' }
  if (!st.isDirectory()) return 'not a real directory'
  if (st.uid !== process.getuid?.()) return 'owned by another user'
  let o: Owner
  try { o = JSON.parse(readFileSync(join(path, OWNER_FILE), 'utf8')) as Owner } catch { return 'no owner record' }
  if (o?.v !== 1 || typeof o.pid !== 'number' || o.root !== path) return 'owner record does not name this root'
  if (o.pid === process.pid || !ownerGone(o)) return 'owner still running'
  return null
}

/** Removes abandoned roots directly in `base`; returns the paths removed. Never descends into anything else. */
export const sweep = (base: string): string[] => {
  const removed: string[] = []
  let names: string[] = []
  try { names = readdirSync(base) } catch { return removed }
  for (const n of names) {
    const p = join(base, n)
    if (sweepProblem(p, n) !== null) continue
    try { rmSync(p, { recursive: true, force: true }); removed.push(p) } catch { /* another sweeper got there first */ }
  }
  return removed
}

const roots: string[] = []
let hooked = false
/** Removes this process's roots now (idempotent). */
export const cleanup = (): void => {
  if (process.env.COCKPIT_TEST_KEEP === '1') return
  for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }) } catch { /* best effort at exit */ } }
}
const hook = (): void => {
  if (hooked) return
  hooked = true
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const h = (): void => { cleanup(); process.removeListener(sig, h); process.kill(process.pid, sig) }
    process.on(sig, h)
  }
}

/** A new root in `base` with its owner record; abandoned roots there are swept first. */
export const makeRoot = (base: string, hidden = false): string => {
  sweep(base)
  const root = mkdtempSync(join(base, hidden ? '.ccl-run-' : 'ccl-run-'))
  writeFileSync(join(root, OWNER_FILE), JSON.stringify({ v: 1, pid: process.pid, start: startTimeOf(process.pid), root } satisfies Owner))
  roots.push(root)
  hook()
  return root
}

// the system temporary directory (or COCKPIT_TEST_TMP), taken before TMPDIR is pointed into the root below
const TMP_BASE = process.env.COCKPIT_TEST_TMP ?? tmpdir()
let tmpRoot: string | null = null
let homeRoot: string | null = null
/** This process's root under the temporary directory. Code under test that uses os.tmpdir() writes inside it too. */
export const tmpRootDir = (): string => {
  if (!tmpRoot) { tmpRoot = makeRoot(TMP_BASE); process.env.TMPDIR = tmpRoot }
  return tmpRoot
}
/** This process's root under HOME (persistent storage that no sandbox mounts), for canaries. */
export const homeRootDir = (): string => { if (!homeRoot) homeRoot = makeRoot(homedir(), true); return homeRoot }

/** A fresh scratch directory for one fixture, inside this process's root. */
export const tmp = (name: string): string => mkdtempSync(join(tmpRootDir(), `ccl-${name}-`))
/** A fresh scratch directory under HOME, inside this process's HOME root. */
export const homeTmp = (name: string): string => mkdtempSync(join(homeRootDir(), `${name}-`))
