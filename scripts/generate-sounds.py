"""Generate 120 distinct, concept-matched StickerWave sound effects and catalog.json."""
import argparse
import hashlib
import json
import math
import random
import re
import struct
import unicodedata
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "public" / "sounds"
ROOT.mkdir(parents=True, exist_ok=True)
RATE = 32000

# ---------------------------------------------------------------------------
# DSP primitives (pure stdlib Python)
# ---------------------------------------------------------------------------

def clamp(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return lo if x < lo else (hi if x > hi else x)


def soft_clip(x: float, drive: float = 1.4) -> float:
    return math.tanh(x * drive) / math.tanh(drive)


def biquad_filter(samples: list[float], kind: str, freq: float, q: float = 1.0) -> list[float]:
    if not samples:
        return []
    w0 = math.tau * clamp(freq, 20.0, RATE * 0.45) / RATE
    cos_w0 = math.cos(w0)
    alpha = math.sin(w0) / (2.0 * max(0.2, q))
    if kind == "lp":
        b0 = (1 - cos_w0) * 0.5
        b1 = 1 - cos_w0
        b2 = (1 - cos_w0) * 0.5
    elif kind == "hp":
        b0 = (1 + cos_w0) * 0.5
        b1 = -(1 + cos_w0)
        b2 = (1 + cos_w0) * 0.5
    else:  # bp
        b0 = alpha
        b1 = 0.0
        b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * cos_w0
    a2 = 1 - alpha
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0
    x1 = x2 = y1 = y2 = 0.0
    out = [0.0] * len(samples)
    for i, x0 in enumerate(samples):
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, x0
        y2, y1 = y1, y0
        out[i] = y0
    return out


def add_echo(samples: list[float], delay_ms: float = 85.0, decay: float = 0.35, passes: int = 3) -> list[float]:
    out = list(samples)
    step = max(1, int(RATE * delay_ms / 1000.0))
    for p in range(1, passes + 1):
        d = step * p
        g = decay ** p
        for i in range(d, len(out)):
            out[i] += samples[i - d] * g
    return out


def mix_into(buf: list[float], src: list[float], start_s: float = 0.0, gain: float = 1.0) -> None:
    off = max(0, int(round(start_s * RATE)))
    end = min(len(buf), off + len(src))
    for i in range(off, end):
        buf[i] += src[i - off] * gain


def synth_tone(
    dur: float,
    freq_fn,
    wave_fn,
    amp_fn=None,
    phase0: float = 0.0,
) -> list[float]:
    n = max(1, int(round(dur * RATE)))
    out = [0.0] * n
    phase = phase0
    for i in range(n):
        t = i / RATE
        x = t / dur
        f = max(15.0, freq_fn(t, x))
        phase += math.tau * f / RATE
        env = amp_fn(t, x) if amp_fn else 1.0
        out[i] = wave_fn(phase, t, x) * env
    return out


def synth_noise(dur: float, rng: random.Random, color: str = "white") -> list[float]:
    n = max(1, int(round(dur * RATE)))
    out = [0.0] * n
    b0 = b1 = b2 = 0.0
    for i in range(n):
        w = rng.uniform(-1.0, 1.0)
        if color == "pink":
            b0 = 0.997 * b0 + w * 0.029
            b1 = 0.985 * b1 + w * 0.032
            b2 = 0.950 * b2 + w * 0.048
            out[i] = (b0 + b1 + b2 + w * 0.18) * 1.4
        elif color == "brown":
            b0 = clamp(b0 * 0.96 + w * 0.14)
            out[i] = b0 * 2.4
        else:
            out[i] = w
    return out


def adsr(t: float, dur: float, a: float = 0.01, d: float = 0.1, s: float = 0.6, r: float = 0.08) -> float:
    if t < a:
        return t / max(1e-4, a)
    if t < a + d:
        return 1.0 - (1.0 - s) * ((t - a) / max(1e-4, d))
    if t > dur - r:
        return s * max(0.0, (dur - t) / max(1e-4, r))
    return s


def poly_square(phase: float, harmonics: int = 5) -> float:
    v = 0.0
    for k in range(1, harmonics * 2, 2):
        v += math.sin(k * phase) / k
    return v * 0.8


def saw_wave(phase: float) -> float:
    p = (phase / math.tau) % 1.0
    return 2.0 * p - 1.0


def tri_wave(phase: float) -> float:
    p = (phase / math.tau) % 1.0
    return 4.0 * abs(p - 0.5) - 1.0


def brass_wave(phase: float, brightness: float = 1.0) -> float:
    return (
        0.55 * math.sin(phase)
        + 0.30 * brightness * math.sin(2 * phase)
        + 0.18 * brightness * math.sin(3 * phase)
        + 0.09 * brightness * math.sin(4 * phase)
    )


def bell_wave(phase: float) -> float:
    return 0.62 * math.sin(phase) + 0.28 * math.sin(phase * 2.01) + 0.14 * math.sin(phase * 3.98)


def finish_samples(samples: list[float], target_peak: float = 0.86) -> list[int]:
    n = len(samples)
    fade_in = min(n // 4, int(0.008 * RATE))
    fade_out = min(n // 3, int(0.035 * RATE))
    for i in range(fade_in):
        samples[i] *= i / max(1, fade_in)
    for i in range(fade_out):
        samples[n - 1 - i] *= i / max(1, fade_out)
    peak = max((abs(v) for v in samples), default=1.0)
    scale = (target_peak / peak) if peak > 1e-6 else 1.0
    return [int(round(clamp(v * scale) * 32767)) for v in samples]


# ---------------------------------------------------------------------------
# Recipe helpers by archetype (each sound calls a tailored recipe + parameters)
# ---------------------------------------------------------------------------

def make_arpeggio(dur: float, notes: list[tuple[float, float, float]], timbre: str = "bell", decay: float = 5.5, echo: bool = False) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, freq, note_dur in notes:
        wf = (
            (lambda p, t, x: bell_wave(p)) if timbre == "bell"
            else (lambda p, t, x: poly_square(p, 4)) if timbre == "8bit"
            else (lambda p, t, x: brass_wave(p, 1.0 - 0.4 * x)) if timbre == "brass"
            else (lambda p, t, x: math.sin(p) + 0.3 * tri_wave(p * 2))
        )
        tone = synth_tone(
            note_dur,
            lambda t, x, f=freq: f,
            wf,
            lambda t, x, nd=note_dur: min(1.0, t / 0.008) * math.exp(-decay * t) * min(1.0, (nd - t) / 0.025),
        )
        mix_into(buf, tone, start, 0.7)
    return add_echo(buf, 95, 0.32, 3) if echo else buf


def make_chord(dur: float, freqs: list[float], timbre: str = "warm", strum: float = 0.035) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for idx, f in enumerate(freqs):
        start = idx * strum
        nd = max(0.1, dur - start)
        wf = (
            (lambda p, t, x: math.sin(p) + 0.25 * math.sin(2 * p) + 0.08 * math.sin(3 * p)) if timbre == "warm"
            else (lambda p, t, x: brass_wave(p, 0.9)) if timbre == "brass"
            else (lambda p, t, x: bell_wave(p))
        )
        tone = synth_tone(
            nd,
            lambda t, x, freq=f: freq * (1.0 + 0.004 * math.sin(math.tau * 5.2 * t)),
            wf,
            lambda t, x, total=nd: adsr(t, total, 0.015, 0.14, 0.65, min(0.28, total * 0.4)),
        )
        mix_into(buf, tone, start, 0.45)
    return add_echo(buf, 75, 0.28, 2)


def make_claps(dur: float, rng: random.Random, density: int = 28, rhythm_only: bool = False) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    if rhythm_only:
        times = [0.04 + i * ((dur - 0.16) / max(1, density - 1)) for i in range(density)]
    else:
        times = sorted(rng.uniform(0.02, dur - 0.14) for _ in range(density))
    for idx, t0 in enumerate(times):
        clap_len = 0.055 if rhythm_only else rng.uniform(0.035, 0.075)
        raw = synth_noise(clap_len, rng, "white")
        # Multi-microburst slap envelope typical of real handclaps
        for j in range(len(raw)):
            tj = j / RATE
            slap = math.exp(-55 * tj) + 0.6 * math.exp(-75 * abs(tj - 0.008))
            raw[j] *= slap
        center = 1250 + (idx % 5) * 190 if rhythm_only else rng.uniform(950, 2400)
        filtered = biquad_filter(raw, "bp", center, 1.4)
        env_gain = 1.0 if rhythm_only else math.sin(math.pi * (t0 / dur)) ** 0.4
        mix_into(buf, filtered, t0, env_gain * 0.95)
    return add_echo(buf, 42, 0.28, 3)


def make_pop(dur: float, f0: float, f1: float) -> list[float]:
    return synth_tone(
        dur,
        lambda t, x: f0 + (f1 - f0) * (1.0 - math.exp(-t / 0.04)),
        lambda p, t, x: math.sin(p) + 0.14 * math.sin(2 * p),
        lambda t, x: min(1.0, t / 0.004) * math.exp(-13.5 * t),
    )


def make_spring(dur: float, f_start: float, f_end: float, wobble_hz: float, wobble_depth: float) -> list[float]:
    return synth_tone(
        dur,
        lambda t, x: (f_start + (f_end - f_start) * x) * (1.0 + wobble_depth * math.sin(math.tau * wobble_hz * t) * (1.0 - 0.4 * x)),
        lambda p, t, x: soft_clip(math.sin(p) + 0.35 * math.sin(2 * p) + 0.15 * saw_wave(p), 1.3),
        lambda t, x: min(1.0, t / 0.008) * math.exp(-2.8 * x) * min(1.0, (dur - t) / 0.04),
    )


def make_honk(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, nd, base in [(0.02, 0.19, 311.0), (0.25, dur - 0.30, 349.0)]:
        horn = synth_tone(
            nd,
            lambda t, x, b=base: b * (1.0 + 0.03 * math.sin(math.tau * 18 * t) - 0.05 * x),
            lambda p, t, x: soft_clip(saw_wave(p) + 0.7 * saw_wave(p * 1.255) + 0.4 * poly_square(p * 0.5, 3), 1.8),
            lambda t, x, d=nd: adsr(t, d, 0.015, 0.04, 0.85, 0.04),
        )
        horn = biquad_filter(horn, "bp", 1050, 0.9)
        mix_into(buf, horn, start, 0.9)
    return buf


def make_bounce_ball(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    t = 0.02
    gap = 0.24
    pitch = 220.0
    while t < dur - 0.06:
        b = synth_tone(
            0.09,
            lambda lt, lx, p0=pitch: p0 * (1.0 + 0.9 * math.exp(-lt * 32)),
            lambda p, lt, lx: math.sin(p) + 0.2 * math.sin(2 * p),
            lambda lt, lx: min(1.0, lt / 0.004) * math.exp(-26 * lt),
        )
        mix_into(buf, b, t, max(0.25, 1.0 - t / dur * 0.6))
        t += gap
        gap = max(0.045, gap * 0.74)
        pitch = min(560.0, pitch * 1.11)
    return buf


def make_knocks(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for t0, f in [(0.06, 168.0), (0.34, 174.0), (0.62, 165.0)]:
        wood = synth_tone(
            0.14,
            lambda t, x, freq=f: freq * (1.0 + 0.8 * math.exp(-t * 95)),
            lambda p, t, x: math.sin(p) + 0.35 * math.sin(p * 2.38) + 0.15 * math.sin(p * 4.1),
            lambda t, x: min(1.0, t / 0.002) * math.exp(-34 * t),
        )
        mix_into(buf, wood, t0, 1.0)
    return add_echo(buf, 68, 0.30, 3)


def make_creak(dur: float, rng: random.Random) -> list[float]:
    n = int(round(dur * RATE))
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        t = i / RATE
        x = t / dur
        # Stick-slip impulse rate speeds up and slows down irregularly
        pulse_hz = 28.0 + 48.0 * math.sin(math.pi * x) ** 1.4 + 10.0 * math.sin(math.tau * 4.3 * t)
        phase += pulse_hz / RATE
        if phase >= 1.0:
            phase -= 1.0
            out[i] = rng.uniform(0.7, 1.0)
        else:
            out[i] = -0.02
    body = biquad_filter(out, "bp", 680, 3.2)
    body2 = biquad_filter(out, "bp", 1420, 4.0)
    return [
        (body[i] * 0.8 + body2[i] * 0.45) * math.sin(math.pi * (i / n)) ** 0.6
        for i in range(n)
    ]


def make_cricket(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for burst_t in [0.06, 0.48, 0.90]:
        if burst_t + 0.25 > dur:
            break
        for pip in range(4):
            pt0 = burst_t + pip * 0.048
            chirp = synth_tone(
                0.032,
                lambda t, x: 4320.0 - 140.0 * x,
                lambda p, t, x: math.sin(p) + 0.18 * math.sin(2 * p),
                lambda t, x: math.sin(math.pi * x),
            )
            mix_into(buf, chirp, pt0, 0.8)
    return add_echo(buf, 55, 0.2, 2)


def make_frog(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, nd, f0, f1 in [(0.04, 0.18, 95.0, 155.0), (0.34, 0.26, 110.0, 185.0)]:
        if start + nd > dur:
            continue
        raw = synth_tone(
            nd,
            lambda t, x, a=f0, b=f1: a + (b - a) * x,
            lambda p, t, x: soft_clip(saw_wave(p) * (0.55 + 0.45 * math.sin(math.tau * 34 * t)), 1.7),
            lambda t, x: math.sin(math.pi * x) ** 0.7,
        )
        formant = biquad_filter(raw, "bp", 640, 2.2)
        mix_into(buf, formant, start, 1.0)
    return buf


def make_bee(dur: float, rng: random.Random) -> list[float]:
    raw = synth_tone(
        dur,
        lambda t, x: 188.0 + 38.0 * math.sin(math.tau * 2.3 * t) + 14.0 * math.sin(math.tau * 7.1 * t) - 24.0 * x,
        lambda p, t, x: saw_wave(p) + 0.45 * saw_wave(p * 1.99) + 0.08 * rng.uniform(-1, 1),
        lambda t, x: (math.sin(math.pi * x) ** 1.3) * (0.7 + 0.3 * math.sin(math.tau * 5.2 * t)),
    )
    return biquad_filter(raw, "bp", 920, 1.1)


def make_owl(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, nd, f0, f1 in [(0.06, 0.20, 420.0, 455.0), (0.38, 0.42, 440.0, 365.0)]:
        if start + nd > dur:
            continue
        hoot = synth_tone(
            nd,
            lambda t, x, a=f0, b=f1: a + (b - a) * (x ** 1.4),
            lambda p, t, x: math.sin(p) + 0.08 * math.sin(2 * p),
            lambda t, x: math.sin(math.pi * x) ** 0.85,
        )
        mix_into(buf, hoot, start, 0.85)
    return add_echo(buf, 110, 0.32, 3)


def make_whale(dur: float) -> list[float]:
    raw = synth_tone(
        dur,
        lambda t, x: 135.0 + 130.0 * math.sin(math.pi * x) ** 1.2 - 35.0 * math.sin(math.tau * 1.8 * t),
        lambda p, t, x: math.sin(p) + 0.28 * math.sin(2 * p) + 0.1 * math.sin(3 * p),
        lambda t, x: math.sin(math.pi * x) ** 1.1,
    )
    return add_echo(biquad_filter(raw, "lp", 750, 1.2), 140, 0.42, 4)


def make_cat_puff(dur: float, rng: random.Random) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    mew = synth_tone(
        dur * 0.55,
        lambda t, x: 560.0 + 240.0 * math.sin(math.pi * x) - 120.0 * x,
        lambda p, t, x: math.sin(p) + 0.35 * saw_wave(p) * 0.4,
        lambda t, x: math.sin(math.pi * x) ** 0.7,
    )
    mix_into(buf, biquad_filter(mew, "bp", 1300, 1.3), 0.03, 0.75)
    hiss = biquad_filter(synth_noise(dur * 0.45, rng, "white"), "hp", 2800, 0.9)
    for i in range(len(hiss)):
        hiss[i] *= math.exp(-7.5 * (i / RATE))
    mix_into(buf, hiss, dur * 0.44, 0.7)
    return buf


def make_bird(dur: float, notes: list[tuple[float, float, float, float]]) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, nd, f0, f1 in notes:
        chirp = synth_tone(
            nd,
            lambda t, x, a=f0, b=f1: a + (b - a) * x + 140 * math.sin(math.tau * 28 * t),
            lambda p, t, x: math.sin(p) + 0.16 * math.sin(2 * p),
            lambda t, x: math.sin(math.pi * x) ** 0.8,
        )
        mix_into(buf, chirp, start, 0.8)
    return add_echo(buf, 65, 0.25, 2)


def make_rain_or_drops(dur: float, rng: random.Random, drop_count: int = 0, surf: bool = False, wind_sweep: bool = False) -> list[float]:
    noise = synth_noise(dur, rng, "pink" if not wind_sweep else "white")
    if surf:
        out = biquad_filter(noise, "lp", 900, 0.8)
        for i in range(len(out)):
            x = i / len(out)
            out[i] *= (0.35 + 0.65 * math.sin(math.pi * x) ** 1.4)
        return out
    if wind_sweep:
        n = len(noise)
        hp = biquad_filter(noise, "bp", 620, 2.8)
        lp = biquad_filter(noise, "bp", 1180, 2.2)
        return [
            (hp[i] * (0.5 + 0.5 * math.sin(math.tau * 0.65 * i / RATE)) + lp[i] * (0.5 + 0.5 * math.cos(math.tau * 0.45 * i / RATE)))
            * math.sin(math.pi * i / n) ** 0.9
            for i in range(n)
        ]
    base = biquad_filter(noise, "hp", 700, 0.7)
    base = biquad_filter(base, "lp", 5200, 0.7)
    for i in range(len(base)):
        base[i] *= math.sin(math.pi * i / len(base)) ** 0.6 * 0.55
    for _ in range(drop_count):
        t0 = rng.uniform(0.08, dur - 0.16)
        f0 = rng.uniform(950, 2300)
        drop = synth_tone(
            0.095,
            lambda t, x, f=f0: f * (1.0 + 0.42 * x),
            lambda p, t, x: math.sin(p),
            lambda t, x: min(1.0, t / 0.002) * math.exp(-38 * t),
        )
        mix_into(base, drop, t0, rng.uniform(0.45, 0.9))
    return add_echo(base, 52, 0.22, 2) if drop_count else base


def make_water_stream(dur: float, rng: random.Random) -> list[float]:
    buf = make_rain_or_drops(dur, rng, drop_count=22, surf=False)
    bp = biquad_filter(buf, "bp", 1350, 1.4)
    return [buf[i] * 0.7 + bp[i] * 0.6 for i in range(len(buf))]


def make_siren(dur: float, f1: float, f2: float, rate_hz: float) -> list[float]:
    return synth_tone(
        dur,
        lambda t, x: f1 if int(t * rate_hz * 2) % 2 == 0 else f2,
        lambda p, t, x: soft_clip(poly_square(p, 4), 1.4),
        lambda t, x: adsr(t, dur, 0.015, 0.05, 0.85, 0.06),
    )


def make_footsteps(dur: float, rng: random.Random, steps: int = 4) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    gap = (dur - 0.25) / max(1, steps)
    for s in range(steps):
        t0 = 0.06 + s * gap
        thud = synth_tone(0.08, lambda t, x: 110 * (1 + 0.9 * math.exp(-t * 70)), lambda p, t, x: math.sin(p), lambda t, x: math.exp(-36 * t))
        tap = biquad_filter(synth_noise(0.04, rng, "white"), "bp", 1700, 1.5)
        for j in range(len(tap)):
            tap[j] *= math.exp(-85 * (j / RATE))
        gain = 0.6 + 0.4 * (s / max(1, steps - 1))
        mix_into(buf, thud, t0, gain)
        mix_into(buf, tap, t0, gain * 0.7)
    return add_echo(buf, 110, 0.4, 4)


def make_typing(dur: float, rng: random.Random) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    t = 0.04
    while t < dur - 0.28:
        click = biquad_filter(synth_noise(0.025, rng, "white"), "bp", rng.uniform(1900, 3400), 2.0)
        for j in range(len(click)):
            click[j] *= math.exp(-160 * (j / RATE))
        mix_into(buf, click, t, rng.uniform(0.65, 1.0))
        t += rng.uniform(0.075, 0.13)
    ding = make_arpeggio(0.32, [(0.0, 1760.0, 0.3)], "bell", 7.0)
    mix_into(buf, ding, dur - 0.34, 0.75)
    return add_echo(buf, 75, 0.25, 2)


def make_heartbeat(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for beat_t in [0.06, 0.22, 0.56, 0.71]:
        if beat_t + 0.14 > dur:
            break
        thump = synth_tone(
            0.13,
            lambda t, x: 92.0 * math.exp(-t * 14) + 38.0,
            lambda p, t, x: math.sin(p) + 0.25 * math.sin(2 * p),
            lambda t, x: min(1.0, t / 0.008) * math.exp(-22 * t),
        )
        mix_into(buf, thump, beat_t, 1.0)
    ping = make_arpeggio(0.32, [(0.0, 1046.5, 0.28)], "bell", 7.0)
    mix_into(buf, ping, dur - 0.34, 0.5)
    return buf


def make_gulp(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    for start, nd, f0, f1 in [(0.05, 0.16, 210.0, 520.0), (0.24, 0.24, 170.0, 690.0)]:
        raw = synth_tone(
            nd,
            lambda t, x, a=f0, b=f1: a + (b - a) * (x ** 1.7),
            lambda p, t, x: math.sin(p) + 0.3 * math.sin(2 * p),
            lambda t, x: math.sin(math.pi * x) ** 0.75,
        )
        mix_into(buf, biquad_filter(raw, "bp", 550, 1.6), start, 1.0)
    return buf


def make_balloon_leak(dur: float, rng: random.Random) -> list[float]:
    raw = synth_tone(
        dur,
        lambda t, x: (1180.0 - 760.0 * (x ** 0.7)) * (1.0 + 0.22 * math.sin(math.tau * 34 * t)),
        lambda p, t, x: soft_clip(saw_wave(p) + 0.25 * rng.uniform(-1, 1), 1.9),
        lambda t, x: (1.0 - 0.7 * x) * (0.65 + 0.35 * math.sin(math.tau * 22 * t)),
    )
    return biquad_filter(raw, "bp", 1250, 1.0)


def make_slide_whistle(dur: float, f0: float, f1: float) -> list[float]:
    return synth_tone(
        dur,
        lambda t, x: f0 + (f1 - f0) * (x ** 1.3),
        lambda p, t, x: math.sin(p) + 0.12 * math.sin(2 * p),
        lambda t, x: adsr(t, dur, 0.015, 0.05, 0.82, 0.08),
    )


def make_trombone_fail(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    notes = [(0.02, 233.08, 0.17), (0.20, 220.0, 0.17), (0.38, 207.65, 0.17), (0.56, 196.0, dur - 0.58)]
    for idx, (s, f, nd) in enumerate(notes):
        tone = synth_tone(
            nd,
            lambda t, x, freq=f, last=(idx == 3): freq * (1.0 - (0.14 * x if last else 0.02 * x) + 0.018 * math.sin(math.tau * 7 * t)),
            lambda p, t, x: brass_wave(p, 0.85),
            lambda t, x, total=nd: adsr(t, total, 0.015, 0.06, 0.78, 0.06),
        )
        mix_into(buf, biquad_filter(tone, "lp", 1300, 1.0), s, 0.9)
    return buf


def make_glitch_stutter(dur: float, rng: random.Random) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    t = 0.02
    while t < dur - 0.06:
        sl = rng.uniform(0.04, 0.09)
        f = rng.choice([260.0, 390.0, 520.0, 780.0, 1040.0])
        g = synth_tone(sl, lambda lt, lx, freq=f: freq, lambda p, lt, lx: poly_square(p, 3), lambda lt, lx: 1.0 if lx < 0.85 else 0.0)
        mix_into(buf, g, t, 0.75)
        t += sl + rng.uniform(0.015, 0.04)
    return buf


def make_drum_groove(dur: float) -> list[float]:
    buf = [0.0] * int(round(dur * RATE))
    rng = random.Random("drum")
    beat = dur / 4.0
    for i in range(4):
        t0 = i * beat
        if i % 2 == 0:
            kick = synth_tone(0.14, lambda t, x: 145 * math.exp(-t * 28) + 46, lambda p, t, x: soft_clip(math.sin(p), 1.4), lambda t, x: math.exp(-18 * t))
            mix_into(buf, kick, t0, 1.0)
        else:
            snare = biquad_filter(synth_noise(0.12, rng, "white"), "hp", 1100, 0.9)
            for j in range(len(snare)):
                snare[j] *= math.exp(-26 * (j / RATE))
            mix_into(buf, snare, t0, 0.8)
        hat = biquad_filter(synth_noise(0.045, rng, "white"), "hp", 5200, 1.2)
        for j in range(len(hat)):
            hat[j] *= math.exp(-65 * (j / RATE))
        mix_into(buf, hat, t0 + beat * 0.5, 0.5)
    return buf


# ---------------------------------------------------------------------------
# Sound definitions: (slug, pt, en, category, tags, durationMs, desc_pt, desc_en, builder)
# ---------------------------------------------------------------------------

def build_catalog():
    rng_global = random.Random("stickerwave-2.2")
    items = []

    def add(slug, pt, en, cat, tags, ms, desc_pt, desc_en, fn):
        assert ms % 10 == 0, f"{slug} duration {ms} must be multiple of 10ms"
        items.append((slug, pt, en, cat, tags, ms, desc_pt, desc_en, fn))

    # ---- ORIGINAL 12 CORE IDS (preserve exact slugs/urls/PT names for tests) ----
    add("pop", "Pop!", "Pop!", "comedy", ["bolha", "bubble", "pop", "garrafa", "estalo"], 650,
        "Estalo seco de rolha e bolha pop.", "Crisp cork-bottle bubble pop.",
        lambda r: make_pop(0.65, 150, 740))
    add("sparkle", "Brilho mágico", "Magic sparkle", "games", ["magia", "magic", "brilho", "estrela", "fantasia"], 1200,
        "Arpejo cintilante de harpa e sinos.", "Shimmering magical harp and bell cascade.",
        lambda r: make_arpeggio(1.20, [(0.00, 659.25, 0.35), (0.08, 783.99, 0.35), (0.16, 987.77, 0.40), (0.24, 1318.51, 0.55), (0.34, 1567.98, 0.70)], "bell", 4.5, True))
    add("boing", "Boing!", "Boing!", "comedy", ["mola", "spring", "desenho", "cartoon", "pulo"], 920,
        "Mola clássica de desenho animado.", "Classic bouncy cartoon spring.",
        lambda r: make_spring(0.92, 260, 420, 11.0, 0.28))
    add("tada", "Tcharam!", "Ta-da!", "reactions", ["fanfarra", "fanfare", "vitoria", "comemoracao", "sucesso"], 1350,
        "Fanfarra triunfante de quatro notas.", "Triumphant four-note brassy fanfare.",
        lambda r: make_arpeggio(1.35, [(0.02, 392.00, 0.16), (0.14, 523.25, 0.16), (0.26, 659.25, 0.18), (0.39, 783.99, 0.90)], "brass", 2.2, True))
    add("ping", "Notificação", "Notification", "interface", ["sino", "bell", "alerta", "aviso", "mensagem"], 720,
        "Toque limpo de vidro para alertas.", "Clean glass bell notification chime.",
        lambda r: make_arpeggio(0.72, [(0.01, 987.77, 0.55), (0.11, 1479.98, 0.55)], "bell", 6.2))
    add("suspense", "Suspense", "Suspense", "reactions", ["drama", "dramatic", "tensao", "medo", "duvida"], 1600,
        "Acorde grave dramático com impacto inicial.", "Dramatic low orchestral sting and swell.",
        lambda r: make_chord(1.60, [82.41, 116.54, 123.47, 233.08], "brass", 0.02))
    add("bonus", "Bônus desbloqueado", "Bonus unlocked", "games", ["8-bit", "arcade", "bonus", "jogo", "premio"], 1200,
        "Sequência arcade 8-bit de conquista.", "Classic 8-bit arcade bonus fanfare.",
        lambda r: make_arpeggio(1.20, [(0.02, 523.25, 0.12), (0.12, 659.25, 0.12), (0.22, 783.99, 0.12), (0.33, 1046.50, 0.72)], "8bit", 3.5))
    add("jump", "Pulo de pixel", "Pixel jump", "games", ["8-bit", "arcade", "pulo", "salto", "mario"], 550,
        "Salto retrô ascendente em onda quadrada.", "Retro ascending square-wave jump.",
        lambda r: synth_tone(0.55, lambda t, x: 240 + 560 * (x ** 0.75), lambda p, t, x: poly_square(p, 4), lambda t, x: min(1, t / 0.006) * math.exp(-4.5 * x)))
    add("click", "Clique duplo", "Double click", "interface", ["botao", "button", "clique", "mouse", "toque"], 420,
        "Estalo tátil duplo de botão mecânico.", "Crisp tactile double switch click.",
        lambda r: make_claps(0.42, r, density=2, rhythm_only=True))
    add("whoosh", "Vupt!", "Whoosh!", "comedy", ["vento", "sweep", "rapido", "passagem", "transicao"], 760,
        "Passagem rápida de ar com corte agudo.", "Fast sweeping air whoosh transition.",
        lambda r: make_rain_or_drops(0.76, r, wind_sweep=True))
    add("oops", "Ops!", "Oops!", "reactions", ["erro", "fail", "falha", "trombone", "meme"], 820,
        "Trombone descendente clássico de erro.", "Classic descending wah-wah fail trombone.",
        lambda r: make_trombone_fail(0.82))
    add("rain", "Chuva suave", "Soft rain", "ambient", ["chuva", "rain", "agua", "calma", "relax"], 2600,
        "Ruído rosa contínuo de chuva leve.", "Gentle continuous pink-noise rainfall.",
        lambda r: make_rain_or_drops(2.60, r, drop_count=6))

    # ---- REACTIONS (17 more -> 20 total) ----
    add("reactions-digital-applause", "Aplauso digital", "Digital applause", "reactions", ["aplauso", "palmas", "applause", "clap", "plateia"], 1500,
        "Salva densa de palmas em grupo.", "Crowd applause burst for wins and jokes.",
        lambda r: make_claps(1.50, r, density=36))
    add("reactions-wow", "Uau", "Wow", "reactions", ["uau", "surpresa", "wow", "admiracao"], 880,
        "Voz sintética ascendente de espanto.", "Ascending vocal-like formant wow sweep.",
        lambda r: biquad_filter(synth_tone(0.88, lambda t, x: 185 + 160 * math.sin(math.pi * x), lambda p, t, x: brass_wave(p, 1.1), lambda t, x: math.sin(math.pi * x) ** 0.7), "bp", 880, 1.8))
    add("reactions-bright-idea", "Boa ideia", "Bright idea", "reactions", ["ideia", "lampada", "ding", "genio", "insight"], 920,
        "Sino agudo de lâmpada acendendo.", "Bright lightbulb-moment glass ding.",
        lambda r: make_arpeggio(0.92, [(0.02, 1567.98, 0.75), (0.04, 2349.32, 0.65)], "bell", 4.2, True))
    add("reactions-perfect-move", "Manobra perfeita", "Perfect move", "reactions", ["perfeito", "acerto", "combo", "estilo"], 960,
        "Escala rápida ascendente de acerto.", "Fast crisp four-note triumph flourish.",
        lambda r: make_arpeggio(0.96, [(0.01, 587.33, 0.11), (0.09, 739.99, 0.11), (0.17, 880.00, 0.12), (0.26, 1174.66, 0.65)], "bell", 4.0))
    add("reactions-relief", "Alívio", "Relief", "reactions", ["alivio", "suspiro", "ufaa", "calma"], 1240,
        "Suspiro suave seguido de acorde calmo.", "Soft exhaling sigh and calming resolve chord.",
        lambda r: [a * 0.45 + b * 0.7 for a, b in zip(make_rain_or_drops(1.24, r, wind_sweep=True), make_chord(1.24, [261.63, 329.63, 392.00, 493.88], "warm", 0.06))])
    add("reactions-green-light", "Sinal verde", "Green light", "reactions", ["verde", "liberado", "ok", "pode", "sim"], 740,
        "Dois tons firmes de sinal liberado.", "Upbeat two-tone green-light confirmation.",
        lambda r: make_arpeggio(0.74, [(0.02, 659.25, 0.18), (0.18, 987.77, 0.52)], "warm", 4.5))
    add("reactions-surprise-pulse", "Vibração surpresa", "Surprise pulse", "reactions", ["vibracao", "alerta", "celular", "choque"], 840,
        "Pulso duplo de vibração com brilho final.", "Double haptic buzz with bright pop.",
        lambda r: [a + b for a, b in zip(make_siren(0.84, 140, 210, 12), make_arpeggio(0.84, [(0.45, 880, 0.35)], "bell", 6.0))])
    add("reactions-quick-win", "Vitória curta", "Quick win", "reactions", ["vitoria", "ganhou", "campeao", "win"], 1080,
        "Jingle curto de vitória em metais.", "Short energetic brass victory jingle.",
        lambda r: make_arpeggio(1.08, [(0.02, 440.0, 0.12), (0.14, 554.37, 0.12), (0.26, 659.25, 0.14), (0.40, 880.0, 0.64)], "brass", 3.0))
    add("reactions-jumping-heart", "Coração saltando", "Jumping heart", "reactions", ["coracao", "paixao", "amor", "batida", "ansioso"], 1120,
        "Batimento cardíaco duplo com sino agudo.", "Double heartbeat thump with joyful chime.",
        lambda r: make_heartbeat(1.12))
    add("reactions-dramatic-pause", "Pausa dramática", "Dramatic pause", "reactions", ["pausa", "choque", "drama", "silencio"], 1300,
        "Batida dramática seguida de tique tenso.", "Impact stab followed by tense ticking.",
        lambda r: [a + b for a, b in zip(make_chord(1.30, [110, 116.54, 220], "brass", 0.0), add_echo(make_claps(1.30, r, 4, True), 240, 0.5, 2))])
    add("reactions-quick-applause", "Palmas curtas", "Quick applause", "reactions", ["palmas", "bravo", "clap", "ritmo"], 900,
        "Cinco palmas secas e rítmicas.", "Five crisp rhythmic handclaps.",
        lambda r: make_claps(0.90, r, density=5, rhythm_only=True))
    add("reactions-approved", "Aprovado", "Approved", "reactions", ["aprovado", "carimbo", "certo", "check", "stamp"], 780,
        "Batida de carimbo com sino de confirmação.", "Rubber-stamp thump and bright chime.",
        lambda r: [a + b for a, b in zip(make_pop(0.78, 180, 75), make_arpeggio(0.78, [(0.16, 1046.5, 0.56)], "bell", 5.0))])
    add("reactions-optimistic-chord", "Acorde otimista", "Optimistic chord", "reactions", ["acorde", "feliz", "positivo", "piano"], 1180,
        "Acorde maior dedilhado com calor harmônico.", "Warm strummed major-ninth chord.",
        lambda r: make_chord(1.18, [261.63, 329.63, 392.00, 493.88, 587.33], "warm", 0.055))
    add("reactions-double-surprise", "Surpresa dupla", "Double surprise", "reactions", ["surpresa", "susto", "plot-twist", "uau"], 940,
        "Dois acordes rápidos subindo de oitava.", "Two sharp stinger chords jumping an octave.",
        lambda r: make_arpeggio(0.94, [(0.03, 392.0, 0.16), (0.03, 493.88, 0.16), (0.28, 783.99, 0.55), (0.28, 987.77, 0.55)], "brass", 4.0))
    add("reactions-euphoria", "Euforia", "Euphoria", "reactions", ["euforia", "festa", "alegria", "brilho"], 1440,
        "Cascata ascendente e luminosa de sinos.", "Ascending euphoric shimmer cascade.",
        lambda r: make_arpeggio(1.44, [(0.02 * i + i * 0.055, 440 * (1.122 ** i), 0.45) for i in range(10)], "bell", 4.2, True))
    add("reactions-reflex", "Reflexo", "Reflex", "reactions", ["reflexo", "ninja", "rapido", "chicote"], 520,
        "Estalo instantâneo de reflexo ágil.", "Lightning-fast reflex whip snap.",
        lambda r: make_pop(0.52, 950, 2100))
    add("reactions-all-clear", "Tudo certo", "All clear", "reactions", ["certo", "ok", "limpo", "pronto"], 860,
        "Duas notas suaves de marimba confirmando.", "Calm marimba two-note all-clear.",
        lambda r: make_arpeggio(0.86, [(0.02, 523.25, 0.25), (0.20, 659.25, 0.60)], "warm", 4.8))

    # ---- COMEDY (17 more -> 20 total) ----
    add("comedy-tired-spring", "Mola cansada", "Tired spring", "comedy", ["mola", "cansado", "preguica", "caindo"], 1140,
        "Mola desacelerando e caindo de tom.", "Sagging spring losing energy and pitch.",
        lambda r: make_spring(1.14, 340, 110, 7.5, 0.22))
    add("comedy-rubber-foot", "Pé de borracha", "Rubber foot", "comedy", ["passo", "borracha", "palhaco", "andar"], 720,
        "Dois passos engraçados de sapato mole.", "Two comical floppy rubber footsteps.",
        lambda r: [a + b for a, b in zip(make_pop(0.72, 290, 140), [0.0]*int(0.28*RATE) + make_pop(0.44, 310, 130))])
    add("comedy-runaway-ball", "Bola fujona", "Runaway ball", "comedy", ["bola", "quicar", "ping-pong", "correndo"], 1360,
        "Bolinha quicando cada vez mais rápido.", "Bouncing rubber ball accelerating rapidly.",
        lambda r: make_bounce_ball(1.36))
    add("comedy-pocket-horn", "Buzina de bolso", "Pocket horn", "comedy", ["buzina", "palhaco", "honk", "comedia", "carro"], 760,
        "Buzina dupla nasal estilo palhaço.", "Classic double clown squeeze horn.",
        lambda r: make_honk(0.76))
    add("comedy-wrong-step", "Passo errado", "Wrong step", "comedy", ["escorregao", "apito", "queda", "tropeco"], 980,
        "Apito escorregando rápido para cima e queda.", "Cartoon slip whistle sliding steeply up.",
        lambda r: make_slide_whistle(0.98, 280, 1650))
    add("comedy-soft-stumble", "Tombo suave", "Soft stumble", "comedy", ["tombo", "desastre", "cair", "trambolhao"], 1040,
        "Tropeço em notas rápidas e baque fofo.", "Tumbling wooden clatter with soft thud.",
        lambda r: make_arpeggio(1.04, [(0.02, 784, 0.10), (0.09, 659, 0.10), (0.16, 523, 0.10), (0.23, 392, 0.12), (0.34, 120, 0.45)], "warm", 6.0))
    add("comedy-stubborn-lid", "Tampa teimosa", "Stubborn lid", "comedy", ["tampa", "pote", "abrir", "pop"], 960,
        "Rangido apertado seguido de estalo final.", "Tight squeaky twist ending in a big pop.",
        lambda r: [a * 0.65 + b for a, b in zip(make_creak(0.96, r), [0.0]*int(0.60*RATE) + make_pop(0.36, 180, 920))])
    add("comedy-sock-drop", "Meia no chão", "Sock drop", "comedy", ["seco", "anticlimax", "sem-graca", "plop"], 560,
        "Queda minúscula e seca de anticlímax.", "Tiny deadpan anticlimactic plop.",
        lambda r: make_pop(0.56, 190, 95))
    add("comedy-leaky-balloon", "Fuga de ar", "Leaky balloon", "comedy", ["balao", "bexiga", "pum", "ar", "comedia"], 1120,
        "Bexiga esvaziando com vibrato agudo.", "Deflating squeaky balloon sputter.",
        lambda r: make_balloon_leak(1.12, r))
    add("comedy-puff", "Baforada", "Puff", "comedy", ["sopro", "ar", "espirro", "bufa"], 540,
        "Sopro percussivo rápido de ar.", "Quick percussive air puff.",
        lambda r: biquad_filter([v * math.exp(-10 * (i / RATE)) for i, v in enumerate(synth_noise(0.54, r, "pink"))], "lp", 1800, 1.0))
    add("comedy-silly-spin", "Giro bobo", "Silly spin", "comedy", ["tonto", "giro", "carrossel", "maluco"], 1180,
        "Arpejo tonto girando em círculos.", "Dizzy wobbling carousel arpeggio.",
        lambda r: make_arpeggio(1.18, [(i * 0.085, 420 + 180 * math.sin(i * 1.3), 0.13) for i in range(12)], "brass", 7.5))
    add("comedy-dizzy-reed", "Palheta tonta", "Dizzy reed", "comedy", ["pato", "quack", "kazoo", "corneta"], 860,
        "Som anasalado tipo pato/kazoo.", "Nasal comic kazoo/duck squawk.",
        lambda r: biquad_filter(make_spring(0.86, 440, 240, 24.0, 0.18), "bp", 980, 2.1))
    add("comedy-tin-spring", "Mola de lata", "Tin spring", "comedy", ["metal", "regua", "twang", "mola"], 920,
        "Vibração metálica de régua na mesa.", "Metallic twangy ruler-on-desk bounce.",
        lambda r: make_spring(0.92, 165, 290, 18.0, 0.35))
    add("comedy-squeaky-shoe", "Sapato molhado", "Squeaky shoe", "comedy", ["sapato", "guincho", "chiado", "tenis"], 880,
        "Três guinchos agudos de borracha no piso.", "Three crisp rubber-on-floor shoe squeaks.",
        lambda r: make_bird(0.88, [(0.04, 0.14, 1850, 2600), (0.28, 0.14, 2100, 2850), (0.52, 0.18, 1950, 2400)]))
    add("comedy-short-gasp", "Espanto curto", "Short gasp", "comedy", ["espanto", "susto", "ui", "chocado"], 640,
        "Puxada de ar rápida de susto.", "Startled cartoon breathy gasp.",
        lambda r: make_slide_whistle(0.64, 520, 1180))
    add("comedy-digital-hiccup", "Gaguejo digital", "Digital hiccup", "comedy", ["glitch", "travou", "bug", "gaguejo"], 820,
        "Cortes rápidos tipo áudio travando.", "Chopped digital buffer stutter glitch.",
        lambda r: make_glitch_stutter(0.82, r))
    add("comedy-gulp", "Glup", "Gulp", "comedy", ["engolir", "nervoso", "medo", "garganta"], 680,
        "Engolida seca clássica de desenho.", "Cartoon nervous throat gulp.",
        lambda r: make_gulp(0.68))

    # ---- SUSPENSE (15 total) ----
    add("suspense-ajar-door", "Porta entreaberta", "Ajar door", "suspense", ["porta", "rangido", "terror", "casa"], 1640,
        "Rangido lento de dobradiça de madeira.", "Eerie slow wooden door creak.",
        lambda r: make_creak(1.64, r))
    add("suspense-mystery-bass", "Baixo misterioso", "Mystery bass", "suspense", ["baixo", "grave", "cinema", "impacto"], 1880,
        "Queda de subgrave cinematográfico.", "Deep cinematic sub-bass mystery drop.",
        lambda r: synth_tone(1.88, lambda t, x: 95 * math.exp(-2.2 * x) + 34, lambda p, t, x: soft_clip(math.sin(p) + 0.35 * math.sin(1.5 * p), 1.5), lambda t, x: min(1, t / 0.03) * (1 - 0.8 * x)))
    add("suspense-slow-shadow", "Sombra lenta", "Slow shadow", "suspense", ["sombra", "sombrio", "escuro", "pad"], 2100,
        "Nuvem sonora escura em trítono.", "Dark creeping tritone shadow pad.",
        lambda r: make_chord(2.10, [110.0, 155.56, 220.0, 311.13], "warm", 0.14))
    add("suspense-fog-alert", "Alerta na névoa", "Fog alert", "suspense", ["neblina", "navio", "buzina", "longe"], 1920,
        "Trompa grave distante na neblina.", "Distant foggy low brass horn.",
        lambda r: make_chord(1.92, [73.42, 110.0], "brass", 0.04))
    add("suspense-dark-pause", "Pausa escura", "Dark pause", "suspense", ["escuro", "vazio", "medo", "eco"], 1560,
        "Ressonância grave com sino solitário.", "Hollow dark room tone with lonely ping.",
        lambda r: [a * 0.5 + b for a, b in zip(make_chord(1.56, [65.41, 98.0], "warm", 0.0), make_arpeggio(1.56, [(0.88, 1318.5, 0.65)], "bell", 4.5, True))])
    add("suspense-distant-signal", "Sinal distante", "Distant signal", "suspense", ["sonar", "submarino", "eco", "radar"], 1720,
        "Pulso solitário de sonar ecoando.", "Echoing underwater sonar ping.",
        lambda r: add_echo(make_arpeggio(1.72, [(0.05, 1174.66, 0.35), (0.85, 1174.66, 0.35)], "bell", 6.5), 180, 0.45, 4))
    add("suspense-basement-vibration", "Vibração no porão", "Basement vibration", "suspense", ["porao", "motor", "tremor", "grave"], 1600,
        "Zumbido mecânico grave pulsante.", "Low ominous mechanical rumble.",
        lambda r: synth_tone(1.60, lambda t, x: 58.0 + 3.0 * math.sin(math.tau * 3.5 * t), lambda p, t, x: soft_clip(saw_wave(p), 1.6), lambda t, x: math.sin(math.pi * x) ** 0.7))
    add("suspense-three-knocks", "Três batidas", "Three knocks", "suspense", ["batida", "porta", "toc-toc", "misterio"], 1280,
        "Três batidas secas em porta de madeira.", "Three distinct hollow wooden door knocks.",
        lambda r: make_knocks(1.28))
    add("suspense-tension-rise", "Subida tensa", "Tension rise", "suspense", ["subida", "riser", "climax", "tensao"], 1800,
        "Crescente tenso acelerando até o corte.", "Rising pitch and tightening tension swell.",
        lambda r: synth_tone(1.80, lambda t, x: 140.0 * (2.6 ** x), lambda p, t, x: brass_wave(p, 0.6 + 0.6 * x) * (0.6 + 0.4 * math.sin(math.tau * (4 + 14 * x) * t)), lambda t, x: min(1, x * 1.15) * (1 if t < 1.74 else 0)))
    add("suspense-omen", "Presságio", "Omen", "suspense", ["sino", "igreja", "fatal", "destino"], 1960,
        "Badalada grave de sino em tom menor.", "Deep ominous minor bell toll.",
        lambda r: make_chord(1.96, [130.81, 155.56, 261.63, 311.13], "bell", 0.01))
    add("suspense-hallway-trace", "Rastro no corredor", "Hallway trace", "suspense", ["passos", "corredor", "perseguicao", "eco"], 1680,
        "Quatro passos lentos se aproximando no eco.", "Four slow echoing hallway footsteps.",
        lambda r: make_footsteps(1.68, r, steps=4))
    add("suspense-low-echo", "Eco grave", "Low echo", "suspense", ["caverna", "eco", "gota", "profundo"], 1540,
        "Impacto profundo reverberando em caverna.", "Deep cavern thump with long echoes.",
        lambda r: add_echo(make_pop(1.54, 150, 58), 195, 0.52, 5))
    add("suspense-strange-horizon", "Horizonte estranho", "Strange horizon", "suspense", ["espaco", "alien", "theremin", "estranho"], 1860,
        "Ondulação misteriosa estilo theremin.", "Eerie wavering theremin-like horizon.",
        lambda r: synth_tone(1.86, lambda t, x: 520 + 90 * math.sin(math.tau * 2.1 * t) + 18 * math.sin(math.tau * 6.5 * t), lambda p, t, x: math.sin(p) + 0.18 * math.sin(3 * p), lambda t, x: math.sin(math.pi * x) ** 0.8))
    add("suspense-night-countdown", "Contagem noturna", "Night countdown", "suspense", ["relogio", "tic-tac", "tempo", "bomba"], 1600,
        "Tique-taque tenso de relógio noturno.", "Tense night clock tick-tock.",
        lambda r: make_claps(1.60, r, density=8, rhythm_only=True))
    add("suspense-restless-hush", "Silêncio inquieto", "Restless hush", "suspense", ["silencio", "brisa", "frio", "arrepio"], 1760,
        "Sopro frio com harmônico agudo sutil.", "Cold whisper breeze with fragile high tone.",
        lambda r: [a * 0.7 + b * 0.35 for a, b in zip(make_rain_or_drops(1.76, r, wind_sweep=True), make_arpeggio(1.76, [(0.6, 1975.5, 1.0)], "bell", 3.0))])

    # ---- ORIGINALS (20 total) ----
    add("originals-space-phone", "Telefone do espaço", "Space phone", "originals", ["telefone", "espaco", "toque", "sci-fi"], 1160,
        "Toque retrô-futurista modulado.", "Ring-modulated futuristic space phone.",
        lambda r: make_siren(1.16, 740, 1110, 9.0))
    add("originals-restless-magnet", "Imã inquieto", "Restless magnet", "originals", ["ima", "metal", "vibracao", "acelerando"], 1080,
        "Estalos magnéticos acelerando rápido.", "Accelerating magnetic snap vibrations.",
        lambda r: make_bounce_ball(1.08))
    add("originals-pixel-secret", "Segredo do pixel", "Pixel secret", "originals", ["pixel", "misterio", "8-bit", "segredo"], 1120,
        "Motivo misterioso 8-bit de descoberta.", "Mysterious 8-bit secret motif.",
        lambda r: make_arpeggio(1.12, [(0.02, 587.33, 0.14), (0.14, 554.37, 0.14), (0.26, 493.88, 0.14), (0.38, 440.0, 0.14), (0.50, 659.25, 0.55)], "8bit", 4.0))
    add("originals-jelly-wind", "Vento de gelatina", "Jelly wind", "originals", ["gelatina", "wobble", "synth", "mole"], 1140,
        "Sintetizador elástico oscilante.", "Wobbly resonant jelly synth.",
        lambda r: make_spring(1.14, 210, 390, 6.0, 0.42))
    add("originals-meme-sensor", "Sensor de memes", "Meme sensor", "originals", ["meme", "radar", "detector", "bip"], 980,
        "Varredura de radar detectando meme.", "Quirky radar sweep and detection bleeps.",
        lambda r: make_arpeggio(0.98, [(0.02, 440, 0.12), (0.18, 660, 0.12), (0.34, 880, 0.12), (0.52, 1320, 0.40)], "8bit", 5.5))
    add("originals-wavi-signal", "Sinal do Wavi", "Wavi signal", "originals", ["wavi", "mascote", "assinatura", "jingle"], 1120,
        "Assinatura sonora oficial do mascote Wavi.", "Wavi mascot bright signature chime.",
        lambda r: make_arpeggio(1.12, [(0.02, 392.0, 0.15), (0.13, 493.88, 0.15), (0.24, 587.33, 0.16), (0.36, 783.99, 0.70)], "bell", 3.5, True))
    add("originals-surprise-key", "Tecla surpresa", "Surprise key", "originals", ["tecla", "funk", "riff", "baixo"], 920,
        "Riff percussivo estilo clavinete.", "Punchy funky staccato clavinet riff.",
        lambda r: make_arpeggio(0.92, [(0.02, 220, 0.14), (0.16, 261.63, 0.14), (0.30, 293.66, 0.14), (0.44, 329.63, 0.40)], "brass", 5.5))
    add("originals-square-beat", "Batida quadrada", "Square beat", "originals", ["batida", "ritmo", "drum", "loop", "groove"], 1280,
        "Loop eletrônico com bumbo, caixa e chimbal.", "Punchy electronic kick-snare-hat loop.",
        lambda r: make_drum_groove(1.28))
    add("originals-friendly-interference", "Interferência amiga", "Friendly interference", "originals", ["radio", "walkie-talkie", "chiado", "sinal"], 860,
        "Sinal simpático de rádio comunicador.", "Cute walkie-talkie squelch and chirp.",
        lambda r: [a * 0.4 + b for a, b in zip(biquad_filter(synth_noise(0.86, r, "white"), "bp", 2100, 2.0), make_arpeggio(0.86, [(0.12, 880, 0.16), (0.34, 1175, 0.40)], "bell", 6.5))])
    add("originals-idea-landed", "Bateu a ideia", "Idea landed", "originals", ["ideia", "impacto", "ding", "eureka"], 940,
        "Descida rápida seguida de ding brilhante.", "Quick drop followed by bright eureka ding.",
        lambda r: [a + b for a, b in zip(make_slide_whistle(0.45, 920, 260) + [0.0]*int(0.49*RATE), [0.0]*int(0.40*RATE) + make_arpeggio(0.54, [(0.0, 1567.98, 0.52)], "bell", 4.5))])
    add("originals-tape-spin", "Giro de fita", "Tape spin", "originals", ["fita", "cassete", "vinil", "tape-stop"], 1040,
        "Desaceleração de fita cassete parando.", "Cassette tape-stop pitch slowdown.",
        lambda r: synth_tone(1.04, lambda t, x: 480.0 * ((1.0 - 0.85 * (x ** 1.6))), lambda p, t, x: brass_wave(p, 0.7), lambda t, x: 1.0 - 0.75 * (x ** 2)))
    add("originals-pocket-orbit", "Órbita de bolso", "Pocket orbit", "originals", ["orbita", "espaco", "lfo", "pulso"], 1240,
        "Modulação orbital girando em ondas.", "Swirling orbital synth modulation.",
        lambda r: synth_tone(1.24, lambda t, x: 320 + 110 * math.sin(math.tau * 3.5 * t), lambda p, t, x: math.sin(p) + 0.3 * math.sin(p * 1.5), lambda t, x: math.sin(math.pi * x) ** 0.7))
    add("originals-digital-siren", "Sereia digital", "Digital siren", "originals", ["sirene", "alerta", "policia", "urgente"], 960,
        "Sirene arcade rápida de dois tons.", "Playful urgent two-tone arcade siren.",
        lambda r: make_siren(0.96, 620, 930, 5.5))
    add("originals-dancing-light", "Lâmpada dançante", "Dancing light", "originals", ["luz", "neon", "brilho", "festa"], 1120,
        "Pulso luminoso com acordes cintilantes.", "Dancing neon arpeggio sparkle.",
        lambda r: make_arpeggio(1.12, [(0.00, 523.25, 0.14), (0.14, 659.25, 0.14), (0.28, 783.99, 0.14), (0.42, 659.25, 0.14), (0.56, 1046.5, 0.50)], "bell", 4.5))
    add("originals-noise-of-nothing", "Barulho de nada", "Noise of nothing", "originals", ["nada", "vazio", "grilo", "constrangido"], 1180,
        "Pausa constrangedora com bloops seco.", "Awkward pause ending in a tiny dry bloop.",
        lambda r: [a * 0.28 + b for a, b in zip(make_cricket(1.18), [0.0] * int(0.68 * RATE) + make_pop(0.50, 380, 510))])
    add("originals-orbital-bubble", "Bolha em órbita", "Orbital bubble", "originals", ["bolha", "agua", "gotas", "futuro"], 1080,
        "Sequência borbulhante de gotas FM.", "Cascading bubbling water-drop sequence.",
        lambda r: make_arpeggio(1.08, [(0.02, 480, 0.12), (0.15, 640, 0.12), (0.28, 860, 0.12), (0.41, 1120, 0.15), (0.56, 1480, 0.45)], "warm", 6.5))
    add("originals-scribbled-sparkle", "Brilho rabiscado", "Scribbled sparkle", "originals", ["rabisco", "lapis", "desenho", "energia"], 960,
        "Riscos rápidos de lápis com brilho.", "Fast pencil scribble and bright ping.",
        lambda r: [a * 0.7 + b for a, b in zip(make_typing(0.96, r), make_arpeggio(0.96, [(0.66, 1480, 0.28)], "bell", 6.0))])
    add("originals-electronic-tomorrow", "Amanhã eletrônico", "Electronic tomorrow", "originals", ["synthwave", "futuro", "epico", "quinta"], 1360,
        "Acorde synthwave quente e aberto.", "Lush synthwave fifth brass swell.",
        lambda r: make_chord(1.36, [146.83, 220.0, 293.66, 440.0], "brass", 0.03))
    add("originals-keyboard-echo", "Eco de teclado", "Keyboard echo", "originals", ["teclado", "digitando", "escritorio", "enter"], 1160,
        "Rajada de digitação mecânica com Enter.", "Rapid mechanical typing burst and ding.",
        lambda r: make_typing(1.16, r))
    add("originals-happy-code", "Código feliz", "Happy code", "originals", ["codigo", "alegre", "chiptune", "prog"], 1120,
        "Melodia alegre 8-bit em dó maior.", "Cheerful major chiptune melody.",
        lambda r: make_arpeggio(1.12, [(0.02, 523.25, 0.14), (0.14, 587.33, 0.14), (0.26, 659.25, 0.14), (0.38, 783.99, 0.14), (0.50, 1046.5, 0.56)], "8bit", 4.2))

    # ---- GAMES (12 more -> 15 total) ----
    add("games-blue-coin", "Moeda azul", "Blue coin", "games", ["moeda", "coin", "ouro", "ponto", "arcade"], 680,
        "Som clássico de moeda coletada (dois tons).", "Crisp classic two-note coin pickup.",
        lambda r: make_arpeggio(0.68, [(0.01, 987.77, 0.085), (0.095, 1318.51, 0.55)], "8bit", 5.0))
    add("games-shield", "Escudo", "Shield", "games", ["escudo", "defesa", "energia", "power-up"], 980,
        "Ativação cristalina de campo de força.", "Crystalline energy force-field sweep.",
        lambda r: [a + b for a, b in zip(make_slide_whistle(0.98, 220, 1180), make_chord(0.98, [440, 659.25, 880], "bell", 0.04))])
    add("games-secret-door", "Porta secreta", "Secret door", "games", ["segredo", "zelda", "puzzle", "rpg", "tesouro"], 1320,
        "Jingle clássico de enigma resolvido.", "Iconic eight-note puzzle-solved chime.",
        lambda r: make_arpeggio(1.32, [(0.02, 783.99, 0.12), (0.13, 739.99, 0.12), (0.24, 622.25, 0.12), (0.35, 440.0, 0.12), (0.46, 415.30, 0.12), (0.57, 659.25, 0.12), (0.68, 830.61, 0.12), (0.79, 1046.5, 0.48)], "bell", 5.5))
    add("games-map-unlocked", "Mapa desbloqueado", "Map unlocked", "games", ["mapa", "aventura", "rpg", "descoberta"], 1240,
        "Acorde heróico de área desbloqueada.", "Warm heroic area-unlocked RPG chord.",
        lambda r: make_arpeggio(1.24, [(0.02, 293.66, 0.18), (0.16, 440.0, 0.18), (0.30, 587.33, 0.20), (0.46, 880.0, 0.72)], "brass", 2.8, True))
    add("games-extra-heart", "Coração extra", "Extra heart", "games", ["vida", "1up", "coracao", "cura", "heal"], 1080,
        "Arpejo 1-UP de vida extra recuperada.", "Bubbly six-note 1-UP extra-life arpeggio.",
        lambda r: make_arpeggio(1.08, [(0.02, 329.63, 0.11), (0.12, 392.00, 0.11), (0.22, 659.25, 0.11), (0.32, 523.25, 0.11), (0.42, 587.33, 0.11), (0.52, 783.99, 0.50)], "8bit", 4.8))
    add("games-level-clear", "Fim de fase", "Level clear", "games", ["fase", "vitoria", "stage", "clear"], 1400,
        "Fanfarra triunfante de fase concluída.", "Upbeat arcade level-clear victory fanfare.",
        lambda r: make_arpeggio(1.40, [(0.02, 392.0, 0.12), (0.14, 523.25, 0.12), (0.26, 659.25, 0.12), (0.38, 783.99, 0.22), (0.58, 659.25, 0.14), (0.72, 1046.5, 0.65)], "8bit", 3.2))
    add("games-checkpoint", "Checkpoint", "Checkpoint", "games", ["save", "checkpoint", "ponto", "progresso"], 960,
        "Sinal duplo de progresso salvo.", "Warm dual-harmonic save-beacon chime.",
        lambda r: make_arpeggio(0.96, [(0.02, 587.33, 0.25), (0.20, 880.0, 0.68)], "bell", 4.0, True))
    add("games-quest-accepted", "Missão aceita", "Quest accepted", "games", ["missao", "quest", "rpg", "aventura"], 1140,
        "Chamada épica de missão aceita.", "Heroic brass fifth quest-accepted call.",
        lambda r: make_chord(1.14, [196.0, 293.66, 392.0, 587.33], "brass", 0.05))
    add("games-light-point", "Ponto de luz", "Light point", "games", ["luz", "orbe", "cristal", "fada"], 840,
        "Toque cristalino agudo de orbe coletado.", "Delicate high crystal-orb pickup.",
        lambda r: make_arpeggio(0.84, [(0.01, 1318.51, 0.24), (0.10, 1760.0, 0.65)], "bell", 5.5))
    add("games-pixel-turbine", "Turbina pixel", "Pixel turbine", "games", ["turbo", "nitro", "corrida", "nave"], 1040,
        "Aceleração de motor/turbo retrô.", "Revving 8-bit turbo boost engine.",
        lambda r: synth_tone(1.04, lambda t, x: 95 + 520 * (x ** 1.4), lambda p, t, x: soft_clip(poly_square(p, 4), 1.5), lambda t, x: adsr(t, 1.04, 0.03, 0.1, 0.85, 0.08)))
    add("games-critical-hit", "Acerto crítico", "Critical hit", "games", ["dano", "espada", "golpe", "critico", "luta"], 740,
        "Impacto pesado com corte metálico.", "Punchy impact crunch with sharp slash.",
        lambda r: [a + b * 0.65 + c for a, b, c in zip(make_pop(0.74, 210, 48), biquad_filter([v * math.exp(-18 * (i / RATE)) for i, v in enumerate(synth_noise(0.74, r, "white"))], "hp", 1800, 1.0), make_arpeggio(0.74, [(0.02, 1396.91, 0.48), (0.04, 2093.0, 0.44)], "8bit", 6.5))])
    add("games-inventory", "Inventário", "Inventory", "games", ["mochila", "menu", "item", "abrir"], 560,
        "Clique de madeira abrindo inventário.", "Crisp wooden UI click opening inventory.",
        lambda r: make_arpeggio(0.56, [(0.01, 440, 0.12), (0.09, 659.25, 0.35)], "warm", 8.5))

    # ---- ANIMALS (10 total) ----
    add("animals-bird-chirp", "Pio de passarinho", "Bird chirp", "animals", ["passaro", "ave", "pio", "bird", "manhã"], 780,
        "Três pios curtos de passarinho.", "Three bright songbird chirps.",
        lambda r: make_bird(0.78, [(0.04, 0.12, 2900, 3950), (0.26, 0.12, 3150, 4200), (0.48, 0.16, 2800, 4100)]))
    add("animals-cricket", "Grilo", "Cricket", "animals", ["grilo", "noite", "silencio", "inseto", "cricket"], 1280,
        "Cri-cri noturno de grilo (ótimo para silêncio constrangedor).", "Authentic pulsed night cricket chirps.",
        lambda r: make_cricket(1.28))
    add("animals-pond-frog", "Rã na lagoa", "Pond frog", "animals", ["sapo", "ra", "coaxar", "frog", "lagoa"], 920,
        "Coaxar duplo grave de sapo na lagoa.", "Low guttural double pond-frog ribbit.",
        lambda r: make_frog(0.92))
    add("animals-double-chirp", "Piu duplo", "Double chirp", "animals", ["passarinho", "piu", "ave", "dois"], 660,
        "Chamado rápido em duas notas agudas.", "Quick tropical two-note bird chirp.",
        lambda r: make_bird(0.66, [(0.05, 0.14, 3400, 4400), (0.28, 0.22, 3800, 3100)]))
    add("animals-bee-buzz", "Zumbido de abelha", "Bee buzz", "animals", ["abelha", "mosca", "zumbido", "inseto", "bee"], 1140,
        "Zumbido rasante de abelha passando perto.", "Close fly-by buzzing bee sweep.",
        lambda r: make_bee(1.14, r))
    add("animals-morning-bird", "Pássaro da manhã", "Morning bird", "animals", ["passaro", "canto", "natureza", "floresta"], 1120,
        "Melodia alegre de quatro pios.", "Cheerful four-note morning songbird.",
        lambda r: make_bird(1.12, [(0.04, 0.15, 2600, 3400), (0.24, 0.15, 3200, 2700), (0.45, 0.16, 3000, 4100), (0.68, 0.26, 3600, 4600)]))
    add("animals-short-owl", "Coruja curta", "Short owl", "animals", ["coruja", "noite", "uhu", "owl"], 1040,
        "Canto suave e grave de coruja (uhu-uhuu).", "Soft breathy owl hoot in the night.",
        lambda r: make_owl(1.04))
    add("animals-curious-insect", "Inseto curioso", "Curious insect", "animals", ["mosquito", "inseto", "voo", "zumbido"], 940,
        "Voo agitado de inseto ziguezagueando.", "Darting erratic high-frequency insect buzz.",
        lambda r: biquad_filter(make_spring(0.94, 520, 680, 28.0, 0.30), "bp", 1600, 1.8))
    add("animals-whale-flute", "Flauta de baleia", "Whale flute", "animals", ["baleia", "mar", "oceano", "canto"], 1560,
        "Canto longo e profundo de baleia.", "Deep haunting underwater whale song.",
        lambda r: make_whale(1.56))
    add("animals-cat-puff", "Sopro de gato", "Cat puff", "animals", ["gato", "miau", "gato-bravo", "cat"], 820,
        "Miado curto seguido de sopro felino.", "Playful short cat mew and soft hiss.",
        lambda r: make_cat_puff(0.82, r))

    # ---- INTERFACE (8 more -> 10 total) ----
    add("interface-soft-tap", "Toque suave", "Soft tap", "interface", ["toque", "ui", "suave", "madeira"], 420,
        "Batida curta e macia de interface.", "Subtle damped wooden UI tap.",
        lambda r: make_pop(0.42, 420, 260))
    add("interface-shortcut", "Atalho", "Shortcut", "interface", ["atalho", "menu", "acao", "ui"], 540,
        "Duas notas rápidas de atalho acionado.", "Slick ascending two-note shortcut.",
        lambda r: make_arpeggio(0.54, [(0.01, 660, 0.14), (0.10, 990, 0.36)], "bell", 7.5))
    add("interface-save", "Salvar", "Save", "interface", ["salvar", "confirmar", "feito", "ok"], 660,
        "Acorde curto confirmando gravação.", "Reassuring two-tone save chime.",
        lambda r: make_arpeggio(0.66, [(0.01, 587.33, 0.22), (0.13, 880.0, 0.45)], "warm", 5.8))
    add("interface-connect", "Conectar", "Connect", "interface", ["conectar", "usb", "bluetooth", "entrar"], 720,
        "Três notas ascendentes de conexão.", "Friendly ascending 3-note connect.",
        lambda r: make_arpeggio(0.72, [(0.01, 440, 0.14), (0.11, 554.37, 0.14), (0.21, 659.25, 0.45)], "bell", 6.0))
    add("interface-disconnect", "Desconectar", "Disconnect", "interface", ["desconectar", "sair", "fechar", "offline"], 720,
        "Três notas descendentes de desconexão.", "Gentle descending 3-note disconnect.",
        lambda r: make_arpeggio(0.72, [(0.01, 659.25, 0.14), (0.11, 554.37, 0.14), (0.21, 440, 0.45)], "bell", 6.0))
    add("interface-back-button", "Botão de volta", "Back button", "interface", ["voltar", "retornar", "clique", "ui"], 460,
        "Clique descendente leve de voltar.", "Crisp downward wooden back click.",
        lambda r: make_arpeggio(0.46, [(0.01, 740, 0.12), (0.08, 490, 0.30)], "warm", 8.0))
    add("interface-sound-check", "Check sonoro", "Sound check", "interface", ["teste", "audio", "check", "calibrar"], 840,
        "Sino limpo em 440 e 880 Hz.", "Clean reference 440-880 Hz bell check.",
        lambda r: make_arpeggio(0.84, [(0.02, 440.0, 0.28), (0.28, 880.0, 0.50)], "bell", 4.5))
    add("interface-short-alert", "Aviso curto", "Short alert", "interface", ["aviso", "bipe", "atencao", "alerta"], 680,
        "Três bipes curtos de atenção.", "Crisp triple notification pip.",
        lambda r: make_arpeggio(0.68, [(0.02, 1046.5, 0.10), (0.16, 1046.5, 0.10), (0.30, 1318.5, 0.30)], "8bit", 7.0))

    # ---- AMBIENT (9 more -> 10 total) ----
    add("ambient-wind-in-leaves", "Vento em folhas", "Wind in leaves", "ambient", ["vento", "arvores", "folhas", "natureza"], 2100,
        "Farfalhar suave de vento nas folhas.", "Whispering breeze rustling through leaves.",
        lambda r: make_rain_or_drops(2.10, r, wind_sweep=True))
    add("ambient-distant-sea", "Mar ao longe", "Distant sea", "ambient", ["mar", "praia", "ondas", "oceano"], 2400,
        "Onda suave quebrando na praia distante.", "Slow rolling distant ocean surf wave.",
        lambda r: make_rain_or_drops(2.40, r, surf=True))
    add("ambient-light-drizzle", "Chuva fina", "Light drizzle", "ambient", ["chuva", "garoa", "tempo", "agua"], 1800,
        "Garoa leve e fina constante.", "Airy light drizzle patter.",
        lambda r: make_rain_or_drops(1.80, r, drop_count=10))
    add("ambient-mist", "Neblina", "Mist", "ambient", ["neblina", "calma", "nuvem", "suave"], 1900,
        "Bruma suave com acorde harmônico aberto.", "Soft misty air over gentle fifth pad.",
        lambda r: [a * 0.45 + b * 0.65 for a, b in zip(make_rain_or_drops(1.90, r, surf=True), make_chord(1.90, [196.0, 293.66, 392.0], "warm", 0.1))])
    add("ambient-window-drops", "Gotas na janela", "Window drops", "ambient", ["gotas", "chuva", "janela", "agua"], 2000,
        "Chuva leve com pingos claros na janela.", "Soft rain with clear water-drop plinks.",
        lambda r: make_rain_or_drops(2.00, r, drop_count=18))
    add("ambient-night-air", "Ar noturno", "Night air", "ambient", ["noite", "calmo", "grilo", "brisa"], 2200,
        "Brisa noturna com grilo ao fundo.", "Cool night breeze with distant crickets.",
        lambda r: [a * 0.55 + b * 0.45 for a, b in zip(make_rain_or_drops(2.20, r, surf=True), make_cricket(2.20))])
    add("ambient-draft", "Corrente de vento", "Draft", "ambient", ["vento", "assobio", "fresta", "frio"], 1720,
        "Assobio suave de vento passando por fresta.", "Whistling doorway wind draft.",
        lambda r: [a * 0.7 + b * 0.35 for a, b in zip(make_rain_or_drops(1.72, r, wind_sweep=True), make_slide_whistle(1.72, 340, 540))])
    add("ambient-beach-breeze", "Brisa de praia", "Beach breeze", "ambient", ["praia", "verao", "sol", "ondas"], 2040,
        "Ondas leves com brilho solar suave.", "Gentle beach waves with airy shimmer.",
        lambda r: [a * 0.7 + b * 0.45 for a, b in zip(make_rain_or_drops(2.04, r, surf=True), make_chord(2.04, [329.63, 493.88, 659.25], "bell", 0.12))])
    add("ambient-running-water", "Água corrente", "Running water", "ambient", ["rio", "riacho", "agua", "natureza"], 2160,
        "Riacho borbulhante com gotas contínuas.", "Babbling brook of running water.",
        lambda r: make_water_stream(2.16, r))

    assert len(items) == 120, f"Expected 120 items, got {len(items)}"
    counts = {}
    for item in items:
        counts[item[3]] = counts.get(item[3], 0) + 1
    assert counts == {"comedy": 20, "reactions": 20, "originals": 20, "games": 15, "suspense": 15, "animals": 10, "interface": 10, "ambient": 10}, counts
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, choices=[40, 120], default=120)
    limit = parser.parse_args().limit
    specs = build_catalog()[:limit]

    # Clean stale wavs in target folder if running full 120 build
    if limit == 120:
        expected_names = {f"{item[0]}.wav" for item in specs}
        for existing in ROOT.glob("*.wav"):
            if existing.name not in expected_names:
                existing.unlink()

    records = []
    for index, (slug, pt, en, category, tags, ms, desc_pt, desc_en, builder) in enumerate(specs):
        rng = random.Random(slug)
        raw_samples = builder(rng)
        pcm = finish_samples(raw_samples)
        target = ROOT / f"{slug}.wav"
        with wave.open(str(target), "wb") as wav:
            wav.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
            wav.writeframes(struct.pack(f"<{len(pcm)}h", *pcm))
        blob = target.read_bytes()
        sha = hashlib.sha256(blob).hexdigest()
        bars = [
            round(max(abs(v) for v in pcm[b * len(pcm) // 32 : (b + 1) * len(pcm) // 32]) / 32767, 3)
            for b in range(32)
        ]
        duration_ms = round(len(pcm) * 1000 / RATE)
        records.append(dict(
            id=slug,
            name={"pt": pt, "en": en},
            description={"pt": desc_pt, "en": desc_en},
            category=category,
            tags=tags,
            durationMs=duration_ms,
            author="StickerWave",
            license="CC0-1.0",
            source="Synthesis / Síntese original",
            bars=bars,
            url=f"/sounds/{target.name}",
            sha256=sha,
            sizeBytes=len(blob),
            sampleRate=RATE,
            channels=1,
            order=index,
            provenance=f"Concept DSP synthesis / {slug}",
            createdAt="2026-11-25",
            variants=[dict(url=f"/sounds/{target.name}", mime="audio/wav", sha256=sha, sizeBytes=len(blob))],
        ))

    (ROOT / "catalog.json").write_text(json.dumps(dict(schemaVersion=1, sounds=records), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Generated {len(records)} distinct sounds at {RATE} Hz.")


if __name__ == "__main__":
    main()
