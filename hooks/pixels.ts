// The pixels under every drawing: colour maths, the cell grid a terminal
// Raster paints, and the text rules the host enforces on it.
//
// Pure and shared. progress-visual.ts draws the track; mascot.ts draws the
// operator; both need the same grid and the same cell arithmetic, and neither
// may import the other. Nothing here reads state or touches the host.

/** A Raster cell's "terminal default" color: bit 24 alone. */
export const DEFAULT = 0x01000000

export const clamp = (n: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, n))

/** `#RRGGBB` to `[r, g, b]`. */
export const hex = (s: string): number[] => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16))

/** `a` moved `m` of the way to `b`, per channel. */
export const mix = (a: number[], b: number[], m: number): number[] =>
  a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))

/** `[r, g, b]` to the `0x00RRGGBB` a Raster cell takes. */
export const pack = (a: number[]): number => ((a[0] ?? 0) << 16) | ((a[1] ?? 0) << 8) | (a[2] ?? 0)

export const rgb = (a: number[]): string => `rgb(${a.join(',')})`

/**
 * A stable 0..1 from three integers. Not `Math.random`: a redraw has to draw
 * the same particles, or the track sparkles for reasons the user never caused.
 */
export const hash = (a: number, b: number, k: number): number => {
  const n = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return n - Math.floor(n)
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/** A task title, a goal, a file path: nothing a caller controls reaches the markup raw. */
export const escapeXml = (s: string): string => s.replace(/[&<>"']/g, c => XML_ESCAPES[c] ?? c)

/** East Asian Wide and Fullwidth: the characters a terminal spends two cells on. */
const wide = (n: number): boolean =>
  n > 0xffff ||
  (n >= 0x1100 && n <= 0x115f) ||
  (n >= 0x2e80 && n <= 0xa4cf) ||
  (n >= 0xac00 && n <= 0xd7a3) ||
  (n >= 0xf900 && n <= 0xfaff) ||
  (n >= 0xfe30 && n <= 0xfe6f) ||
  (n >= 0xff00 && n <= 0xff60) ||
  (n >= 0xffe0 && n <= 0xffe6)

const COMBINING = /\p{Mark}|\u200d|\ufe0f/u
const combining = (s: string): boolean => COMBINING.test(s)

/** The cells `s` occupies: what a Raster and a Text both lay it out by. */
export const cellsOf = (s: string): number =>
  [...s].reduce((n, c) => n + (combining(c) ? 0 : wide(c.codePointAt(0) ?? 0) ? 2 : 1), 0)

/** `s` cut to `width` cells, with an ellipsis where it had to go. */
export const fitText = (s: string, width: number): string => {
  const clean = s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').normalize('NFC')
  if (cellsOf(clean) <= width) return clean
  if (width <= 1) return width > 0 ? '…' : ''
  let out = ''
  for (const c of clean) {
    if (cellsOf(out + c) > width - 1) break
    out += c
  }
  return out.trimEnd() + '…'
}

// A Raster accepts only printable width-one BMP characters. Text and SVG keep
// Unicode; only inside a cell grid does a wide or unprintable character become
// a safe placeholder, or the host refuses the whole tree.
const RASTER_PLACEHOLDER = '·'

export const rasterText = (s: string): string =>
  [...s.normalize('NFC')]
    .filter(c => !combining(c))
    .map(c => (wide(c.codePointAt(0) ?? 0) ? RASTER_PLACEHOLDER : /[\x00-\x1f\x7f-\x9f]/.test(c) ? ' ' : c))
    .join('')

/**
 * The width of `s` in a tracked, uppercase technical face, in CSS pixels. Only
 * ever used to size a pill that has room to shrink, so an estimate is enough;
 * monospace is the fallback case and it is exact.
 */
export const textWidth = (s: string, px = 7.4): number => {
  let total = 0
  for (const c of s) {
    const n = c.codePointAt(0) ?? 0
    total +=
      n > 0xffff || (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) ? px * 1.7 : (/[ilI.,:;'|!\[\]·]/.test(c) ? px * 0.5 : /[mwMW@#%]/.test(c) ? px * 1.35 : px)
  }
  return total
}

/** One row of cells: what a Raster draws and `$.ui.blit` repaints in place. */
export class Grid {
  readonly cells: [number, number, number][]
  constructor(
    readonly width: number,
    readonly rows = 1,
  ) {
    this.cells = Array.from({ length: width * rows }, () => [32, DEFAULT, DEFAULT])
  }
  set(x: number, y: number, cp: number | string, fg: number, bg: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.rows) return
    this.cells[y * this.width + x] = [typeof cp === 'string' ? cp.codePointAt(0) ?? 32 : cp, fg, bg]
  }
  text(x: number, y: number, s: string, fg: number, bg: number) {
    [...rasterText(s)].forEach((c, i) => this.set(x + i, y, c, fg, bg))
  }
  encode(): string {
    const bytes = new Uint8Array(this.cells.length * 12)
    const dv = new DataView(bytes.buffer)
    this.cells.forEach((c, i) => c.forEach((v, k) => dv.setUint32(i * 12 + k * 4, v, true)))
    let bin = ''
    for (const byte of bytes) bin += String.fromCharCode(byte)
    return btoa(bin)
  }
}