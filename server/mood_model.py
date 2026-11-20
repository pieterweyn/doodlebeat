"""Mood → mix settings.

A *mood* is a weighted blend of genres plus a strength (0 = leave the song as it is, 1 = full mood).
The song's own genre (you pick it when the song loads) is the starting point: the mix moves FROM that genre
TOWARD the mood, so only the difference is applied. EQ and level move both ways; width scales by the ratio;
compression, saturation and reverb can only be added (what is baked into a recording can't be taken out).
With no song genre the start is NEUTRAL (= treat the recording as a blank slate).
The model turns a mood into one *settings vector* per instrument (the processing to apply):

    eq      5 gains in dB for the bands in SCHEMA['bands']   (low shelf, 3 peaks, high shelf)
    comp    0..1  compression amount     (threshold/ratio/makeup formulas in js/dsp.js and render.py)
    sat     0..1  saturation amount
    reverb  0..1  reverb send
    width   0..2  stereo width (1 = unchanged, 0 = mono)
    level   dB    level offset

PLUGIN POINT. `PlaceholderMoodModel` uses hand-tuned presets and a linear blend. A trained model only has to
implement the same methods (`settings(weights, amount, instrument, source)`, `embed`, `origin`, `genre_points`), e.g.:
  v1  per (genre, instrument) average features of Demucs stems from genre-tagged songs → least-squares fit
      of EQ gains / compression to the difference from the instrument's all-genre average.
  v2  instrument-conditioned VAE over those features; the mood point is the weighted blend of genre
      centroids in latent space, decoded to settings (trained through differentiable DSP, e.g. dasp-pytorch).
Select it with the DOODLEBEAT_MODEL environment variable in `load_model()`.
"""
import os

import numpy as np

GENRES = [
    # id, name, color (also the anchor on the color pad: hue + lightness), one-line character
    {'id': 'lofi', 'name': 'Lo-fi', 'color': '#c27a4a', 'blurb': 'dusty highs, warm mids, soft squash, cozy room'},
    {'id': 'jazz', 'name': 'Jazz', 'color': '#9b5cf0', 'blurb': 'natural dynamics, warm body, open room'},
    {'id': 'rock', 'name': 'Rock', 'color': '#ff3b4e', 'blurb': 'forward mids, crunch, punchy compression'},
    {'id': 'edm', 'name': 'EDM', 'color': '#22e3d2', 'blurb': 'huge lows, scooped mud, bright air, wide & loud'},
    {'id': 'hiphop', 'name': 'Hip-hop', 'color': '#f5c518', 'blurb': 'sub-heavy, upfront vocal, dry & tight'},
    {'id': 'cinematic', 'name': 'Cinematic', 'color': '#3f6bff', 'blurb': 'wide, deep reverb, gentle dynamics, air'},
]
GENRE_IDS = [g['id'] for g in GENRES]
INSTRUMENTS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

SCHEMA = {
    'bands': [
        {'type': 'lowshelf', 'freq': 90, 'q': 0.71, 'label': 'Low'},
        {'type': 'peaking', 'freq': 300, 'q': 0.9, 'label': 'Low-mid'},
        {'type': 'peaking', 'freq': 1100, 'q': 0.9, 'label': 'Mid'},
        {'type': 'peaking', 'freq': 3500, 'q': 0.9, 'label': 'Presence'},
        {'type': 'highshelf', 'freq': 9500, 'q': 0.71, 'label': 'Air'},
    ],
    'ranges': {'eq': [-12, 12], 'comp': [0, 1], 'sat': [0, 1], 'reverb': [0, 1], 'width': [0, 2], 'level': [-12, 6]},
}
NEUTRAL = {'eq': [0.0] * 5, 'comp': 0.0, 'sat': 0.0, 'reverb': 0.0, 'width': 1.0, 'level': 0.0}

# ---- Placeholder presets: hand-tuned, NOT learned. Genre character first, then instrument tweaks. ----
_GENRE_BASE = {
    'lofi':      {'eq': [1.5, 2.0, -1.0, -3.0, -8.0], 'comp': 0.45, 'sat': 0.55, 'reverb': 0.30, 'width': 0.75},
    'jazz':      {'eq': [1.0, 1.5, 0.0, 1.0, -2.0], 'comp': 0.15, 'sat': 0.12, 'reverb': 0.35, 'width': 1.15},
    'rock':      {'eq': [2.0, -1.5, 2.5, 3.0, 1.5], 'comp': 0.60, 'sat': 0.45, 'reverb': 0.18, 'width': 1.25},
    'edm':       {'eq': [5.0, -3.5, -1.0, 2.0, 4.5], 'comp': 0.80, 'sat': 0.25, 'reverb': 0.30, 'width': 1.50},
    'hiphop':    {'eq': [6.0, -1.0, -2.0, 2.5, 1.0], 'comp': 0.65, 'sat': 0.30, 'reverb': 0.10, 'width': 1.00},
    'cinematic': {'eq': [2.5, -1.0, -1.5, 1.0, 3.0], 'comp': 0.25, 'sat': 0.05, 'reverb': 0.70, 'width': 1.60},
}
# (genre, instrument) → overrides. 'eq+' adds per band, other keys replace (or 'level' adds).
_TWEAKS = {
    ('lofi', 'drums'): {'level': -2, 'eq+': [0, 0, 0, -1, -3]}, ('lofi', 'vocals'): {'level': -1},
    ('jazz', 'bass'): {'level': 2, 'eq+': [2, 0, 0, 0, 0]}, ('jazz', 'piano'): {'level': 1, 'eq+': [0, 0, 0, 1.5, 0]},
    ('jazz', 'drums'): {'level': -2, 'comp': 0.05},
    ('rock', 'guitar'): {'level': 2, 'sat': 0.6, 'eq+': [0, 0, 1.5, 0, 0]}, ('rock', 'drums'): {'comp': 0.7, 'eq+': [3, 0, 0, 0, 0]},
    ('rock', 'vocals'): {'eq+': [0, 0, 0, 1.5, 0]},
    ('edm', 'drums'): {'level': 2, 'comp': 0.85, 'eq+': [2, 0, 0, 0, 0]}, ('edm', 'bass'): {'sat': 0.4, 'eq+': [1, 0, 0, 0, 0]},
    ('edm', 'vocals'): {'reverb': 0.45, 'eq+': [0, 0, 0, 0, 1]}, ('edm', 'guitar'): {'level': -4}, ('edm', 'piano'): {'reverb': 0.5},
    ('hiphop', 'drums'): {'level': 3, 'eq+': [1, 0, 0, 0, 0]}, ('hiphop', 'bass'): {'level': 2, 'eq+': [1, 0, 0, 0, 0]},
    ('hiphop', 'vocals'): {'level': 3, 'comp': 0.75, 'eq+': [-4, 0, 0, 1.5, 0]}, ('hiphop', 'guitar'): {'level': -3},
    ('hiphop', 'other'): {'level': -2},
    ('cinematic', 'drums'): {'level': -3, 'reverb': 0.55}, ('cinematic', 'other'): {'level': 2, 'reverb': 0.8},
    ('cinematic', 'piano'): {'level': 1, 'reverb': 0.75}, ('cinematic', 'vocals'): {'reverb': 0.5},
}
# Instrument rules applied to every genre: keep the low end mono and tight, drums drier.
_INSTRUMENT_RULES = {
    'bass': {'width_max': 0.4, 'reverb_mul': 0.2, 'air_mul': 0.3},
    'drums': {'reverb_mul': 0.5},
    'vocals': {'width_max': 1.1, 'reverb_mul': 0.8},
}


def _preset(genre: str, instrument: str) -> dict:
    base = _GENRE_BASE[genre]
    s = {**NEUTRAL, **{k: (list(v) if k == 'eq' else v) for k, v in base.items()}}
    for k, v in _TWEAKS.get((genre, instrument), {}).items():
        if k == 'eq+':
            s['eq'] = [a + b for a, b in zip(s['eq'], v)]
        elif k == 'level':
            s['level'] += v
        else:
            s[k] = v
    r = _INSTRUMENT_RULES.get(instrument, {})
    if 'width_max' in r:
        s['width'] = min(s['width'], r['width_max'])
    s['reverb'] *= r.get('reverb_mul', 1)
    s['eq'][4] *= r.get('air_mul', 1)
    return s


def to_vec(s: dict) -> np.ndarray:
    return np.array(list(s['eq']) + [s['comp'], s['sat'], s['reverb'], s['width'], s['level']], dtype=np.float64)


def from_vec(v) -> dict:
    lo, hi = SCHEMA['ranges']['eq']
    c = lambda x, k: float(np.clip(x, *SCHEMA['ranges'][k]))
    return {'eq': [float(np.clip(x, lo, hi)) for x in v[:5]], 'comp': c(v[5], 'comp'), 'sat': c(v[6], 'sat'),
            'reverb': c(v[7], 'reverb'), 'width': c(v[8], 'width'), 'level': c(v[9], 'level')}


# Per-dimension scale so dB and 0..1 parameters weigh comparably in the 2D map
_SCALE = np.array([12] * 5 + [1, 1, 1, 2, 12], dtype=np.float64)


class PlaceholderMoodModel:
    info = {'name': 'placeholder', 'trained': False,
            'description': 'Hand-tuned genre × instrument presets, blended linearly. '
                           'The 2D map is a PCA of those presets (stand-in for a learned latent space).'}

    def __init__(self):
        self.presets = {i: {g: to_vec(_preset(g, i)) for g in GENRE_IDS} for i in INSTRUMENTS}
        self.neutral = to_vec(NEUTRAL)
        self.pca = {}
        for i in INSTRUMENTS:
            X = np.stack([self.presets[i][g] for g in GENRE_IDS] + [self.neutral]) / _SCALE
            mu = X.mean(0)
            _, _, vt = np.linalg.svd(X - mu, full_matrices=False)
            self.pca[i] = (mu, vt[:2])

    def _inst(self, instrument: str) -> str:
        return instrument if instrument in self.presets else 'other'

    def _start(self, i: str, source: str | None) -> np.ndarray:
        return self.presets[i][source] if source in GENRE_IDS else self.neutral

    def point(self, weights: dict, amount: float, instrument: str, source: str | None = None) -> np.ndarray:
        """Where the song ends up (absolute genre character): from its own genre toward the mood."""
        i = self._inst(instrument)
        w = np.array([max(0.0, float(weights.get(g, 0))) for g in GENRE_IDS])
        w = w / w.sum() if w.sum() > 0 else w
        start = self._start(i, source)
        target = sum(wk * self.presets[i][g] for wk, g in zip(w, GENRE_IDS)) if w.sum() > 0 else start
        return start + float(np.clip(amount, 0, 1)) * (target - start)

    def settings(self, weights: dict, amount: float, instrument: str, source: str | None = None) -> dict:
        """The processing that takes the recording (in genre `source`) to the mood."""
        i = self._inst(instrument)
        p, start = self.point(weights, amount, i, source), self._start(i, source)
        d = p - start
        v = d.copy()
        v[5:8] = np.maximum(0.0, d[5:8])                      # comp, sat, reverb: can only add
        v[8] = p[8] / start[8] if start[8] > 1e-6 else p[8]   # width: ratio to the recording's width
        return from_vec(v)

    def embed_vec(self, v: np.ndarray, instrument: str) -> list:
        mu, P = self.pca[self._inst(instrument)]
        return [float(x) for x in P @ (v / _SCALE - mu)]

    def embed(self, s: dict, instrument: str) -> list:
        return self.embed_vec(to_vec(s), instrument)

    def position(self, weights: dict, amount: float, instrument: str, source: str | None = None) -> list:
        """The mood's point on the genre map (absolute, not the processing)."""
        return self.embed_vec(self.point(weights, amount, instrument, source), instrument)

    def origin(self, instrument: str, source: str | None = None) -> list:
        """The recording's point on the genre map: its genre, or 'as recorded' (neutral)."""
        i = self._inst(instrument)
        return self.embed_vec(self._start(i, source), i)

    def genre_points(self, instrument: str) -> dict:
        i = self._inst(instrument)
        pts = {g: self.embed(from_vec(self.presets[i][g]), i) for g in GENRE_IDS}
        pts['_neutral'] = self.embed(NEUTRAL, i)
        return pts


def load_model():
    name = os.environ.get('DOODLEBEAT_MODEL', 'placeholder')
    if name == 'placeholder':
        return PlaceholderMoodModel()
    raise ValueError(f'Unknown DOODLEBEAT_MODEL "{name}". Add the trained model class in mood_model.py.')
