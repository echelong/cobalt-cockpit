#!/usr/bin/env python3
"""Renders VECTOR into the directory icon.

The geometry is not redrawn here: it is the portrait `hooks/mascot.ts` already
draws in the HUD, printed from that module and scaled whole, so the icon cannot
drift from the operator the person sees. The panel's own rules hold — the hood
is unlit and the visor does all the talking — and the ground is the page behind
everything, `PALETTE.void`.

Needs: node and TypeScript (the module compiled to read its SVG), ImageMagick
with librsvg (the SVG rasterized), Python 3 standard library (the composition).
Writes `.claude-plugin/icon.png`: 1024x1024, under 2 MB, no text chunks.

    python3 scripts/make-icon.py [state] [scale]
"""
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATES = ('idle', 'running', 'glitch', 'needs_input', 'error', 'done')
SIZE = 1024
VOID = '#07080A'  # PALETTE.void: the page behind everything
state = sys.argv[1] if len(sys.argv) > 1 else 'idle'
scale = int(sys.argv[2]) if len(sys.argv) > 2 else 36
assert state in STATES, f'state must be one of {STATES}'
icon = ROOT / '.claude-plugin' / 'icon.png'

with tempfile.TemporaryDirectory() as tmp:
    build = Path(tmp) / 'js'
    subprocess.run(['npx', 'tsc', 'hooks/mascot.ts', 'hooks/pixels.ts', 'hooks/theme.ts', '--outDir', str(build),
                    '--module', 'commonjs', '--target', 'es2023', '--moduleResolution', 'node', '--skipLibCheck'],
                   cwd=ROOT, check=True)
    svg = subprocess.run(['node', '-e',
                          f'process.stdout.write(require({str(build / "mascot.js")!r}).mascotSvg({state!r}, false))'],
                         check=True, capture_output=True, text=True).stdout
    assert svg.startswith('<svg ') and svg.rstrip().endswith('</svg>'), 'the module did not print a portrait'
    source = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    assert source is not None, 'the portrait carries no viewBox'
    width, height = int(source.group(1)), int(source.group(2))
    scale_svg, raw = Path(tmp) / 'mark.svg', Path(tmp) / 'mark.png'
    scale_svg.write_text(re.sub(r'width="\d+" height="\d+"', f'width="{width * scale}" height="{height * scale}"', svg, count=1))
    clean = ['-depth', '8', '-strip', '-define', 'png:include-chunk=none']  # no date, no software tag, no profile
    subprocess.run(['magick', '-background', 'none', str(scale_svg), *clean, str(raw)], check=True)
    icon.parent.mkdir(exist_ok=True)
    subprocess.run(['magick', '-size', f'{SIZE}x{SIZE}', f'xc:{VOID}', str(raw), '-gravity', 'center',
                    '-composite', *clean, str(icon)], check=True)

data = icon.read_bytes()
assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
held, depth, kind, at, chunks = struct.unpack('>II', data[16:24]), data[24], data[25], 8, []
while at < len(data):
    length, name = struct.unpack('>I', data[at:at + 4])[0], data[at + 4:at + 8].decode('ascii')
    chunks.append(name)
    at += 12 + length
assert held == (SIZE, SIZE), held
assert depth == 8 and kind in (2, 6), (depth, kind)
assert set(chunks) == {'IHDR', 'IDAT', 'IEND'}, chunks
assert len(data) < 2 * 1024 * 1024, len(data)
print(f'{icon.relative_to(ROOT)}: {held[0]}x{held[1]}, 8-bit {"RGB" if kind == 2 else "RGBA"}, '
      f'{len(data)} bytes, {state} portrait at {scale}x, chunks {sorted(set(chunks))}')
