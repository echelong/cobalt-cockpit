// Terminal foundation for the Cockpit HUD: colour capability, the Cobalt tokens, width-safe text
// and a flicker-free screen writer. Pure functions except `Screen`, which only writes to a stream.
// The palette is the Claude Code Cockpit's own (hooks/theme.ts), so both cockpits read alike.
import { PALETTE } from '../core/engine.ts'

export type ColorMode = 'truecolor' | '256' | '16' | 'none'

/** Colour support from the environment. `COCKPIT_COLOR` overrides; `NO_COLOR` (any value) wins over all. */
export const colorMode = (env: NodeJS.ProcessEnv = process.env, tty = true): ColorMode => {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  const forced = env.COCKPIT_COLOR
  if (forced === 'none' || forced === '16' || forced === '256' || forced === 'truecolor') return forced
  if (!tty || env.TERM === 'dumb') return 'none'
  if (/^(?:truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor'
  if (/256/.test(env.TERM ?? '')) return '256'
  return '16'
}
/** Reduced motion: no spinner, no waveform, a static frame that changes only when state does. */
export const reducedMotion = (env: NodeJS.ProcessEnv = process.env): boolean => /^(?:1|true|yes)$/i.test(env.COCKPIT_REDUCED_MOTION ?? '') || /^(?:1|true|yes)$/i.test(env.COCKPIT_STATIC ?? '')

// Semantic tokens. Foregrounds on a dark terminal use the bright partner of each state colour so
// small monospace text keeps its contrast; the deep tones are kept for filled badges.
const TOKENS = {
  accent: PALETTE.red, accentGlow: PALETTE.redGlow, head: PALETTE.silver, label: PALETTE.steel, rule: '#2B313C',
  ok: PALETTE.greenGlow, okFill: PALETTE.green, warn: PALETTE.amberGlow, warnFill: PALETTE.amber,
  fail: '#FF3352', failFill: PALETTE.redDeep, scan: PALETTE.cyan, scanFill: PALETTE.cyanDeep, idle: '#8A90A2', idleFill: '#646A7E',
} as const
export type Token = keyof typeof TOKENS
// 16-colour fallbacks: the nearest basic SGR colour (90 = bright black for quiet labels and rules)
const BASIC: Record<Token, number> = { accent: 91, accentGlow: 91, head: 97, label: 90, rule: 90, ok: 92, okFill: 42, warn: 93, warnFill: 43, fail: 91, failFill: 41, scan: 96, scanFill: 46, idle: 37, idleFill: 100 }

const rgbOf = (hex: string): [number, number, number] => { const n = Number.parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
/** Nearest xterm-256 index: the 6×6×6 cube or the grey ramp, whichever is closer. */
export const xterm256 = (hex: string): number => {
  const [r, g, b] = rgbOf(hex)
  const level = (v: number): number => v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40)
  const steps = [0, 95, 135, 175, 215, 255]
  const [lr, lg, lb] = [level(r), level(g), level(b)]
  const cube = 16 + 36 * lr + 6 * lg + lb
  const cubeErr = (steps[lr] - r) ** 2 + (steps[lg] - g) ** 2 + (steps[lb] - b) ** 2
  const grey = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)))
  const gv = 8 + grey * 10
  const greyErr = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2
  return greyErr < cubeErr ? 232 + grey : cube
}

const ESC = '\x1b['
/** Styling bound to one colour mode. Every helper returns the text unchanged in `none`. */
export class Paint {
  constructor(readonly mode: ColorMode) {}
  private fgCode(t: Token): string {
    const hex = TOKENS[t]
    if (this.mode === 'truecolor') { const [r, g, b] = rgbOf(hex); return `38;2;${r};${g};${b}` }
    if (this.mode === '256') return `38;5;${xterm256(hex)}`
    const c = BASIC[t]; return String(c >= 40 && c < 50 ? c - 10 : c >= 100 ? c - 10 : c)
  }
  private bgCode(t: Token): string {
    const hex = TOKENS[t]
    if (this.mode === 'truecolor') { const [r, g, b] = rgbOf(hex); return `48;2;${r};${g};${b}` }
    if (this.mode === '256') return `48;5;${xterm256(hex)}`
    const c = BASIC[t]; return String(c >= 100 ? c : c >= 90 ? c + 10 : c >= 40 && c < 50 ? c : c + 10)
  }
  private wrap(codes: string, s: string): string { return this.mode === 'none' || !s ? s : `${ESC}${codes}m${s}${ESC}0m` }
  fg(t: Token, s: string, bold = false): string { return this.wrap(`${bold ? '1;' : ''}${this.fgCode(t)}`, s) }
  bold(s: string): string { return this.wrap('1', s) }
  dim(s: string): string { return this.mode === 'none' ? s : this.fg('label', s) }
  /** A filled state pill: ` RUNNING ` on the state's fill. In `none`, brackets carry the shape. */
  pill(t: Token, s: string): string { return this.mode === 'none' ? `[${s}]` : this.wrap(`1;97;${this.bgCode(t)}`, ` ${s} `) }
  inverse(s: string): string { return this.mode === 'none' ? `>${s}<` : this.wrap('7', s) }
}

// ----- width-safe text ---------------------------------------------------------------------------
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')
const zeroWidth = (cp: number): boolean => (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || cp === 0xfe0e || (cp >= 0x20d0 && cp <= 0x20ff)
const wide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
  (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
export const charWidth = (ch: string): number => { const cp = ch.codePointAt(0) ?? 0; return cp < 32 ? 0 : zeroWidth(cp) ? 0 : wide(cp) ? 2 : 1 }
/** Visible columns of a (possibly styled) string. */
export const vlen = (s: string): number => { let n = 0; for (const ch of stripAnsi(s)) n += charWidth(ch); return n }
/** Control characters a worker might print (bells, cursor moves, OSC) never reach the screen. */
// eslint-disable-next-line no-control-regex
export const sanitize = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '  ')

/** Pads or cuts a styled string to exactly n visible columns; a cut ends in `…` and resets style. */
export const fit = (s: string, n: number): string => {
  if (n <= 0) return ''
  // one screen row: a line break or tab inside data never splits or shifts the row
  if (/[\n\r\t]/.test(s)) s = s.replace(/\r?\n|\r/g, ' ⏎ ').replace(/\t/g, ' ')
  const w = vlen(s)
  if (w <= n) return s + ' '.repeat(n - w)
  let out = ''; let seen = 0; let i = 0; let styled = false
  while (i < s.length) {
    if (s[i] === '\x1b') { const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i)); if (m) { out += m[0]; styled = true; i += m[0].length; continue } }
    const ch = String.fromCodePoint(s.codePointAt(i) as number); const cw = charWidth(ch)
    if (seen + cw > n - 1) break
    out += ch; seen += cw; i += ch.length
  }
  return `${out}${styled ? `${ESC}0m` : ''}…${' '.repeat(Math.max(0, n - 1 - seen))}`
}
/** Cuts plain text in the middle (paths, long model ids): `cline/src/…/shell.ts`. */
export const midcut = (s: string, n: number): string => {
  if (vlen(s) <= n) return s
  if (n <= 1) return '…'.slice(0, n)
  const chars = [...s]; const head = Math.ceil((n - 1) * 0.45); const tail = n - 1 - head
  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(-tail).join('') : ''}`
}
/**
 * Shortens a model's display name to n columns by dropping middle words first, so the family and the
 * checkpoint stay readable ("DeepSeek V4.1 Flash 1017" → "DeepSeek 1017"); a midcut is the last resort.
 */
export const shortName = (name: string, n: number): string => {
  if (vlen(name) <= n) return name
  const words = name.split(' ')
  while (words.length > 2 && vlen(words.join(' ')) > n) words.splice(words.length - 2, 1)
  const s = words.join(' ')
  return vlen(s) <= n ? s : midcut(s, n)
}
/** Word-wraps plain text to n columns; words longer than a line are broken. */
export const wrap = (text: string, n: number): string[] => {
  const out: string[] = []
  if (n < 1) return out
  for (const raw of text.split('\n')) {
    let line = ''; let lw = 0
    for (const word of raw.split(/(\s+)/)) {
      if (!word) continue
      const ww = vlen(word)
      if (lw + ww <= n) { line += word; lw += ww; continue }
      if (/^\s+$/.test(word)) { out.push(line); line = ''; lw = 0; continue }
      if (lw) { out.push(line.replace(/\s+$/, '')); line = ''; lw = 0 }
      let rest = [...word]
      while (rest.length) {
        let take = 0; let tw = 0
        while (take < rest.length && tw + charWidth(rest[take]) <= n) { tw += charWidth(rest[take]); take++ }
        if (take === 0) take = 1
        const piece = rest.slice(0, take).join(''); rest = rest.slice(take)
        if (rest.length) out.push(piece); else { line = piece; lw = vlen(piece) }
      }
    }
    out.push(line.replace(/\s+$/, ''))
  }
  return out
}
/** Right-aligns styled text in n columns. */
export const right = (s: string, n: number): string => { const w = vlen(s); return w >= n ? fit(s, n) : ' '.repeat(n - w) + s }
/** Two styled strings on one line of n columns: left-aligned and right-aligned, the left cut first. */
export const spread = (l: string, r: string, n: number): string => {
  const rw = vlen(r)
  if (rw + 2 > n) return fit(l, n)
  return fit(l, n - rw - 1) + ' ' + r
}

// ----- formatting ------------------------------------------------------------------------------------
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}
/** Token counts the way the Claude Cockpit prints them; null (not reported) is `—`, never 0. */
export const tokens = (n: number | null): string => n === null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
export const money = (v: number | null): string => v === null ? '—' : v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : v < 10 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`
export const bar = (fraction: number, n: number): { filled: number; empty: number } => { const f = Math.max(0, Math.min(n, Math.round(Math.max(0, Math.min(1, fraction)) * n))); return { filled: f, empty: n - f } }

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
/** A running marker: a braille spinner, or a static `●` with reduced motion. */
export const spinner = (frame: number, motion: boolean): string => motion ? SPIN[frame % SPIN.length] : '●'
const WAVE = '▁▂▃▄▅▆▇█'
/** The Claude Cockpit's activity waveform: two beating sines, flat when idle or with reduced motion. */
export const wave = (frame: number | null, n: number): string => Array.from({ length: n }, (_, c) => {
  if (frame === null) return WAVE[0]
  const carrier = Math.sin(frame * 0.55 + c * 0.9); const env = 0.55 + 0.45 * Math.sin(frame * 0.21 + c * 1.7)
  return WAVE[Math.max(0, Math.min(7, Math.round(3.5 + 3.5 * carrier * env)))]
}).join('')

// ----- the screen writer -------------------------------------------------------------------------
/**
 * Writes frames without flicker: inside a synchronized-update block, only rows that changed since
 * the last frame are rewritten (each padded to the full width, so no erase is needed), then the
 * cursor goes back to the input line. A resize or `invalidate()` repaints everything once.
 */
export class Screen {
  private prev: string[] = []
  private size = ''
  writes = 0
  constructor(private out: { write(s: string): unknown }) {}
  invalidate(): void { this.prev = [] }
  draw(lines: string[], cols: number, rows: number, cursor: { row: number; col: number }): void {
    const size = `${cols}x${rows}`
    let buf = `${ESC}?2026h${ESC}?25l`
    if (size !== this.size) { buf += `${ESC}2J`; this.prev = []; this.size = size }
    for (let i = 0; i < rows; i++) {
      const line = lines[i] ?? ''
      if (this.prev[i] === line) continue
      buf += `${ESC}${i + 1};1H${line}${ESC}0m`
    }
    this.prev = lines.slice(0, rows)
    buf += `${ESC}${cursor.row};${Math.max(1, Math.min(cols, cursor.col))}H${ESC}?25h${ESC}?2026l`
    this.out.write(buf); this.writes++
  }
}
