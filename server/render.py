"""Final render with pedalboard: the same chain the browser previews live, applied offline at full quality.

Per channel:  EQ (8 bands) → saturation → compressor → stereo width → level  ──┬──→ mix bus
                                                                             └─ reverb send → convolution reverb ┘
Mix bus:      mix EQ (8 bands, hand-set) → glue compressor → limiter

The EQ is computed with the same biquad formulas as the browser's BiquadFilterNode (Web Audio spec), so the
export matches the live preview: low cut, low shelf, four bells, high shelf, high cut.

The parameter formulas must stay identical to js/dsp.js so the export sounds like the live preview.
"""
import zipfile
from pathlib import Path

import numpy as np
from pedalboard import Compressor, Gain, Limiter, Pedalboard
from scipy.signal import oaconvolve, sosfilt

import audio_io
from mood_model import SCHEMA

IR_SECONDS, IR_DECAY = 2.4, 3.0


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


# ---- EQ (mirror js/dsp.js: bandBiquads + the Web Audio biquad formulas) ----
BUTTER = {12: [0.7071], 24: [0.5412, 1.3066], 36: [0.5176, 0.7071, 1.9319], 48: [0.5098, 0.6013, 0.9, 2.5629]}
CUTS = ('highpass', 'lowpass')


def band_biquads(b: dict) -> list[dict]:
    if not b.get('on'):
        return []
    if b['type'] in CUTS:
        qs, k = BUTTER.get(int(b.get('slope') or 24), BUTTER[24]), b['q'] / 0.71
        return [{'type': b['type'], 'freq': b['freq'], 'q': q * k if i == len(qs) - 1 else q, 'gain': 0.0} for i, q in enumerate(qs)]
    return [{'type': b['type'], 'freq': b['freq'], 'q': b['q'], 'gain': b.get('gain', 0.0)}]


def biquad_sos(t: str, f0: float, q: float, gain: float, sr: int) -> list[float]:
    """One second-order section, normalized (Web Audio spec; shelves use slope S = 1)."""
    f0 = min(max(f0, 1.0), sr / 2 * 0.999)
    w0 = 2 * np.pi * f0 / sr
    cw, sw, A = np.cos(w0), np.sin(w0), 10 ** (gain / 40)
    if t in CUTS:
        al = sw / (2 * q)
        b = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] if t == 'lowpass' else [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + al, -2 * cw, 1 - al]
    elif t == 'peaking':
        al = sw / (2 * q)
        b, a = [1 + al * A, -2 * cw, 1 - al * A], [1 + al / A, -2 * cw, 1 - al / A]
    else:
        al, sA = sw / 2 * np.sqrt(2), np.sqrt(A)
        if t == 'lowshelf':
            b = [A * ((A + 1) - (A - 1) * cw + 2 * sA * al), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - 2 * sA * al)]
            a = [(A + 1) + (A - 1) * cw + 2 * sA * al, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - 2 * sA * al]
        else:
            b = [A * ((A + 1) + (A - 1) * cw + 2 * sA * al), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - 2 * sA * al)]
            a = [(A + 1) - (A - 1) * cw + 2 * sA * al, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - 2 * sA * al]
    return [b[0] / a[0], b[1] / a[0], b[2] / a[0], 1.0, a[1] / a[0], a[2] / a[0]]


def legacy_bands(eq: list, freqs: list | None) -> list[dict]:
    """Settings without 'bands' (the mood model's 5-band 'eq') → bands."""
    freqs = freqs or [b['freq'] for b in SCHEMA['bands']]
    return [{'type': b['type'], 'on': True, 'freq': f, 'q': b['q'], 'gain': g} for b, g, f in zip(SCHEMA['bands'], eq, freqs)]


def apply_eq(y: np.ndarray, bands: list[dict], sr: int) -> np.ndarray:
    sos = [biquad_sos(q['type'], q['freq'], q['q'], q['gain'], sr) for b in bands for q in band_biquads(b)
           if not (q['type'] not in CUTS and abs(q['gain']) < 1e-4)]
    return y if not sos else sosfilt(np.array(sos), y, axis=-1).astype(np.float32)


def process_channel(y: np.ndarray, s: dict, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Returns (processed stereo signal, reverb send) for one channel."""
    bands = s.get('bands') or legacy_bands(s['eq'], s.get('freqs'))
    y = apply_eq(y.astype(np.float32), bands, sr)
    if s['sat'] > 1e-3:
        y = saturate(y, s['sat'])
    if s['comp'] > 1e-3:
        params, makeup_db = comp_params(s['comp'])
        y = Compressor(**params)(y.astype(np.float32), sr) * 10 ** (makeup_db / 20)
    mid, side = (y[0] + y[1]) / 2, (y[0] - y[1]) / 2 * s['width']
    y = np.stack([mid + side, mid - side]) * 10 ** (s['level'] / 20)
    return y.astype(np.float32), (y * s['reverb'] * REVERB_SEND).astype(np.float32)


def render(channels: list[dict], n: int, out_path: Path, sr: int = audio_io.SR, stems: bool = False,
           mix_eq: dict | None = None) -> Path:
    """channels: [{'path', 'name', 'settings', 'gain_db', 'muted', 'texture'?, 'texture_wet'?}]. Writes a WAV (mix) or a ZIP (stems).
    mix_eq: {'bands': [band ×8]}, the combined EQ on the whole mix."""
    ir = reverb_ir(sr)
    # The mix EQ is linear, so it goes on every track: the stems then still sum to the mix.
    bus_bands = (mix_eq or {}).get('bands')
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
        t = (dry + wet) * g
        if bus_bands:
            t = apply_eq(np.asarray(t, dtype=np.float32), bus_bands, sr)
        tracks.append((ch['name'], t))
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
