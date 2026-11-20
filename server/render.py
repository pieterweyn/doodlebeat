"""Final render with pedalboard: the same chain the browser previews live, applied offline at full quality.

Per channel:  EQ (5 bands) → saturation → compressor → stereo width → level  ──┬──→ mix bus
                                                                             └─ reverb send → convolution reverb ┘
Mix bus:      glue compressor → limiter

The parameter formulas must stay identical to js/dsp.js so the export sounds like the live preview.
"""
import zipfile
from pathlib import Path

import numpy as np
from pedalboard import Compressor, Gain, HighShelfFilter, Limiter, LowShelfFilter, Pedalboard, PeakFilter
from scipy.signal import oaconvolve

import audio_io
from mood_model import SCHEMA

IR_SECONDS, IR_DECAY = 2.4, 3.0
_FILTERS = {'lowshelf': LowShelfFilter, 'peaking': PeakFilter, 'highshelf': HighShelfFilter}


# ---- shared formulas (mirror js/dsp.js) ----
def comp_params(c: float):
    return {'threshold_db': -2 - 28 * c, 'ratio': 1 + 7 * c, 'attack_ms': 10, 'release_ms': 150}, 7 * c


def saturate(y: np.ndarray, s: float) -> np.ndarray:
    m, d = min(1.0, 1.5 * s), 1 + 6 * s
    return (1 - m) * y + m * np.tanh(d * y) / d * (1 + 0.3 * s)


def reverb_ir(sr: int) -> np.ndarray:
    """Decaying stereo noise, normalized to unit energy per channel (the browser builds the same shape)."""
    n = int(sr * IR_SECONDS)
    t = np.arange(n) / n
    ir = np.random.default_rng(7).uniform(-1, 1, (2, n)) * (1 - t) ** IR_DECAY
    return (ir / np.sqrt((ir ** 2).sum(axis=1, keepdims=True))).astype(np.float32)


REVERB_SEND = 0.5


def process_channel(y: np.ndarray, s: dict, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Returns (processed stereo signal, reverb send) for one channel."""
    freqs = s.get('freqs') or [b['freq'] for b in SCHEMA['bands']]  # hand-moved band frequencies, if any
    board = Pedalboard([_FILTERS[b['type']](cutoff_frequency_hz=float(f), gain_db=float(g), q=b['q'])
                        for b, g, f in zip(SCHEMA['bands'], s['eq'], freqs)])
    y = board(y.astype(np.float32), sr)
    if s['sat'] > 1e-3:
        y = saturate(y, s['sat'])
    if s['comp'] > 1e-3:
        params, makeup_db = comp_params(s['comp'])
        y = Compressor(**params)(y.astype(np.float32), sr) * 10 ** (makeup_db / 20)
    mid, side = (y[0] + y[1]) / 2, (y[0] - y[1]) / 2 * s['width']
    y = np.stack([mid + side, mid - side]) * 10 ** (s['level'] / 20)
    return y.astype(np.float32), (y * s['reverb'] * REVERB_SEND).astype(np.float32)


def render(channels: list[dict], n: int, out_path: Path, sr: int = audio_io.SR, stems: bool = False) -> Path:
    """channels: [{'path', 'name', 'settings', 'gain_db', 'muted', 'texture'?, 'texture_wet'?}]. Writes a WAV (mix) or a ZIP (stems)."""
    ir = reverb_ir(sr)
    tracks = []
    for ch in channels:
        if ch['muted']:
            continue
        y, _ = audio_io.load(ch['path'])
        y = audio_io.fit_length(audio_io.to_stereo(y), n)
        if ch.get('texture'):  # RAVE texture blended wet/dry before the mood chain (as in the browser)
            t, _ = audio_io.load(ch['texture'])
            w = ch['texture_wet']
            y = (1 - w) * y + w * audio_io.fit_length(audio_io.to_stereo(t), n)
        elif ch.get('levels'):  # color-driven latent levels: same crossfade weights as the browser
            w, wet = ch['texture_wet'], 0
            for path, weight in ch['levels']:
                if weight > 1e-4:
                    t, _ = audio_io.load(path)
                    wet = wet + weight * audio_io.fit_length(audio_io.to_stereo(t), n)
            y = (1 - w) * y + w * wet
        dry, send = process_channel(y, ch['settings'], sr)
        g = 10 ** (ch['gain_db'] / 20)
        wet = np.stack([oaconvolve(send[k], ir[k])[:n] for k in range(2)]) if send.any() else 0
        tracks.append((ch['name'], (dry + wet) * g))
    if not tracks:
        raise ValueError('Every channel is muted.')

    if stems:  # aligned stems for GarageBand: each starts at 0:00, mood processing and reverb baked in
        peak = max(float(np.abs(sum(t for _, t in tracks)).max()), 1e-9)
        scale = min(1.0, 0.98 / peak)  # one common gain so the stems still sum to the mix
        with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
            used = set()
            for name, t in tracks:
                fn = name
                while fn in used:
                    fn += '_'
                used.add(fn)
                tmp = out_path.with_suffix(f'.{fn}.wav')
                audio_io.save(tmp, t * scale, sr, subtype='PCM_24')
                z.write(tmp, f'{fn}.wav')
                tmp.unlink()
        return out_path

    mix = sum(t for _, t in tracks).astype(np.float32)
    master = Pedalboard([Compressor(threshold_db=-14, ratio=3, attack_ms=10, release_ms=200), Limiter(threshold_db=-1), Gain(gain_db=-1)])  # JUCE limiter makes up to 0 dBFS
    return audio_io.save(out_path, master(mix, sr), sr, subtype='PCM_24')
