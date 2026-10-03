// The two cues and the players that can play them. `$.audio.play` has no
// player on a Linux terminal, so the plugin runs one itself (register.tsx):
// PipeWire's first, then the common fallbacks, then the terminal bell, then
// silence.

import type { Cue } from './model'

export const ASSETS: Record<Cue, string> = {
  checkpoint: 'assets/sounds/checkpoint.wav',
  complete: 'assets/sounds/complete.wav',
}

export type Player = { name: string; argv: (file: string, volume: number) => string[] }

const percent = (volume: number): string => String(Math.round(volume * 100))

/** In order of preference; the first that starts and exits 0 is kept for the session. */
export const PLAYERS: readonly Player[] = [
  { name: 'pw-play', argv: (file, volume) => ['pw-play', `--volume=${volume.toFixed(2)}`, file] },
  { name: 'paplay', argv: (file, volume) => ['paplay', `--volume=${Math.round(volume * 65536)}`, file] },
  { name: 'aplay', argv: file => ['aplay', '-q', file] },
  { name: 'ffplay', argv: (file, volume) => ['ffplay', '-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', percent(volume), file] },
  { name: 'mpv', argv: (file, volume) => ['mpv', '--no-video', '--really-quiet', `--volume=${percent(volume)}`, file] },
  { name: 'play', argv: (file, volume) => ['play', '-q', '-v', volume.toFixed(2), file] },
  { name: 'canberra-gtk-play', argv: file => ['canberra-gtk-play', '-f', file] },
  { name: 'afplay', argv: (file, volume) => ['afplay', '-v', volume.toFixed(2), file] },
  // the last resort: the terminal's own bell
  { name: 'bell', argv: () => ['sh', '-c', 'printf "\\a" > /dev/tty'] },
]

export const PLAY_TIMEOUT_MS = 5_000

export const clampVolume = (volume: unknown): number => {
  const value = typeof volume === 'number' && Number.isFinite(volume) ? volume : 0.6

  return Math.min(1, Math.max(0, value))
}
