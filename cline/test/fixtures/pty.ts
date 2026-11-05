// Drives the real `cockpit-cline` interactive shell in a pseudo-terminal (util-linux `script`),
// the way a person uses it: keystrokes in, rendered frames out. The shell writes each frame as
// plain text to COCKPIT_SHELL_FRAME, which is what the tests read.
import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE, HERE, tmp } from '../helpers.ts'

export const BIN = join(HERE, '..', 'bin', 'cockpit-cline')

export type Pty = { child: ChildProcess; frame: () => string; raw: () => string; send: (s: string) => void; waitFor: (re: RegExp, ms?: number) => Promise<string>; exited: Promise<number | null>; pid: () => number | null; stateDir: string; resize: (cols: number, rows: number) => void }

export const KEYS = { enter: '\r', esc: '\x1b', tab: '\t', ctrlC: '\x03', ctrlD: '\x04', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', pgUp: '\x1b[5~', pgDn: '\x1b[6~' }

/** A hermetic test config: fast retry backoff, nothing hidden, small budgets. */
export const testConfigFile = (over: Record<string, unknown> = {}): string => {
  const f = join(tmp('cfg'), 'config.json')
  writeFileSync(f, JSON.stringify({ sandbox: { hide: [] }, limits: { retryBaseMs: 1500, retryMaxMs: 3000, minFreeMemoryMB: 0, maxLoadPerCpu: 1000, workerTimeoutSeconds: 60, spawnsPerMinute: 10000 }, ...over }))
  return f
}

export const openShell = (o: { repo: string; root: string; data: string; cols?: number; rows?: number; args?: string[]; config?: string; env?: Record<string, string> }): Pty => {
  const frameFile = join(tmp('frame'), 'frame.txt')
  const args = ['shell', '--repo', o.repo, '--state', o.root, '--config', o.config ?? testConfigFile(), ...(o.args ?? [])]
  const cmd = `stty cols ${o.cols ?? 160} rows ${o.rows ?? 46}; exec ${[BIN, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, COCKPIT_SHELL_FRAME: frameFile, COCKPIT_CLINE_BIN: FAKE, COCKPIT_CLINE_DATA: o.data, NO_COLOR: '', COCKPIT_COLOR: '', COCKPIT_REDUCED_MOTION: '', ...(o.env ?? {}) } })
  let raw = ''
  child.stdout?.on('data', d => { raw += d.toString() }); child.stderr?.on('data', d => { raw += d.toString() })
  const exited = new Promise<number | null>(r => child.on('exit', c => r(c)))
  const frame = (): string => { try { return readFileSync(frameFile, 'utf8') } catch { return '' } }
  const waitFor = async (re: RegExp, ms = 30_000): Promise<string> => {
    const until = Date.now() + ms
    for (;;) {
      const f = frame()
      if (re.test(f)) return f
      if (Date.now() > until) throw new Error(`frame never matched ${re}\n--- last frame ---\n${f}\n--- raw tail ---\n${raw.slice(-1500)}`)
      await new Promise(r => setTimeout(r, 100))
    }
  }
  const send = (s: string): void => { child.stdin?.write(s) }
  /** The node process running this shell (not `script` or the shell wrapper). */
  const pid = (): number | null => {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
    for (const line of out.split('\n')) { const m = /^\s*(\d+)\s+(\S+)\s(.*)$/.exec(line); if (m && /(?:^|\/)node$/.test(m[2]) && m[3].includes('src/cli.ts shell') && m[3].includes(o.root)) return Number(m[1]) }
    return null
  }
  /** A real window resize: sets the terminal size on the shell's pty, so the kernel sends it SIGWINCH. */
  const resize = (cols: number, rows: number): void => {
    const node = pid(); if (!node) throw new Error('shell process not found')
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(node)], { encoding: 'utf8' }).trim()
    execFileSync('stty', ['-F', `/dev/${tty}`, 'cols', String(cols), 'rows', String(rows)])
  }
  const p: Pty = { child, frame, raw: () => raw, send, waitFor, exited, pid, stateDir: o.root, resize }
  OPEN.add(p); void exited.then(() => OPEN.delete(p))
  return p
}

/** Shells still open (a failed assertion leaves its shell running); killShells ends them. */
const OPEN = new Set<Pty>()
export const killShells = async (): Promise<void> => {
  for (const p of [...OPEN]) { const pid = p.pid(); if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } try { p.child.kill('SIGKILL') } catch { /* gone */ } }
  await Promise.race([Promise.all([...OPEN].map(p => p.exited)), new Promise(r => setTimeout(r, 3000))])
}

/** Types a message the way a person does and presses Enter. */
export const type = async (p: Pty, text: string): Promise<void> => {
  for (const chunk of text.match(/.{1,40}/gs) ?? []) { p.send(chunk); await new Promise(r => setTimeout(r, 15)) }
  p.send(KEYS.enter)
}

export const lastConversation = (state: string): string | null => {
  const dir = join(state, 'missions')
  if (!existsSync(dir)) return null
  const ids = execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  return ids.at(-1) ?? null
}
