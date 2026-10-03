# Synthesizes the two Cobalt Cockpit cues: 16-bit mono PCM, 44.1 kHz.
import math, struct, sys, wave

RATE = 44100

def render(notes, path, gain):
    # notes: (start_s, freq_hz, length_s, level, partials)
    total = max(start + length for start, _, length, _, _ in notes) + 0.03
    frames = [0.0] * int(total * RATE)
    for start, freq, length, level, partials in notes:
        first = int(start * RATE)
        count = int(length * RATE)
        for n in range(count):
            t = n / RATE
            attack = min(1.0, t / 0.004)
            decay = math.exp(-t * (5.0 / length))
            tone = sum(a * math.sin(2 * math.pi * freq * k * t) for k, a in partials)
            frames[first + n] += level * attack * decay * tone
    peak = max(abs(v) for v in frames) or 1.0
    with wave.open(path, 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(b''.join(
            struct.pack('<h', int(max(-1.0, min(1.0, v / peak * gain)) * 32767)) for v in frames))

SOFT = [(1, 1.0), (2, 0.18)]
BELL = [(1, 1.0), (2, 0.35), (3, 0.12), (4.2, 0.05)]

out = sys.argv[1]
# checkpoint: one short, quiet, low blip
render([(0.0, 660.0, 0.12, 1.0, SOFT)], f'{out}/checkpoint.wav', 0.30)
# complete: rising three-note bell figure, clearly longer and brighter
render([(0.00, 523.25, 0.22, 0.8, BELL),
        (0.11, 783.99, 0.24, 0.9, BELL),
        (0.22, 1046.50, 0.55, 1.0, BELL)], f'{out}/complete.wav', 0.55)
