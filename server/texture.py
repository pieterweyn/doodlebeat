"""RAVE 'texture': resynthesize a stem through a pretrained RAVE model, then blend wet/dry in the mix.

Inference only, no training: a pretrained TorchScript export (.ts) is loaded with torch.jit.load, the stem is
encoded block by block into the latent z, decoded back to audio, and the model's latency is removed by
cross-correlation. Same procedure as RAVE/ATHENS_RAVE/ATHENS_RGB_RAVE_Local.ipynb (offset 0 = plain
reconstruction). The prior is not used.

Put trusted .ts files in doodlebeat/models/rave/ (they are listed automatically). TorchScript files can run arbitrary code, so only use
files from a source you trust (e.g. https://acids-ircam.github.io/rave_models_download).
"""
import math
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import audio_io

MODEL_DIR = Path(__file__).resolve().parent.parent / 'models' / 'rave'
BLOCK = 2048
CHUNK_BLOCKS = 16  # encode/decode 16 blocks per call (faster than one block at a time)


# What each model on the ACIDS download page was trained on (shown as a tooltip). Keys are lowercase file names.
# A model can only re-voice a stem in the sound world it was trained on, so each one suits some stems.
TRAINED_ON = {
    'sol_ordinario_fast': ('IRCAM Studio OnLine, ordinario sounds (RAVE v2 small)', 'orchestral', ['piano', 'guitar', 'other', 'vocals']),
    'sol_ordinario': ('IRCAM Studio OnLine, ordinario sounds', 'orchestral', ['piano', 'guitar', 'other']),
    'sol_full': ('the entire IRCAM Studio OnLine database', 'orchestral', ['piano', 'guitar', 'other']),
    'musicnet': ('MusicNet (classical recordings)', 'classical', ['piano', 'other']),
    'isis': ('ISiS singing-voice database', 'singing', ['vocals']),
    'vctk': ('VCTK speech corpus (48 kHz)', 'speech', ['vocals']),
    'vintage': ('80 h of vintage music', 'vintage', ['other', 'piano', 'guitar']),
    'percussion': ('8 h of percussion recordings', 'percussion', ['drums']),
    'nasa': ('Apollo 11 mission recordings', 'radio voice', ['vocals']),
    'darbouka': ('8 h of darbouka recordings', 'percussion', ['drums']),
}
INPUT_RMS_DB = -20.0  # RAVE reacts strongly to input level (docs), so every stem goes in at the same loudness


_meta_cache: dict = {}


def _latent_meta(path: Path) -> dict:
    """Latent size and how much of the sound each latent dimension carries, read from the export.
    v2 exports store `fidelity` = cumulative explained variance of the PCA-rotated latent (dim 0 first)."""
    key = (path, path.stat().st_mtime)
    if key not in _meta_cache:
        import torch
        m = torch.jit.load(str(path), map_location='cpu')
        try:
            size = int(m.latent_size)
        except Exception:
            size = int(m.encode_params[2])  # older exports: [in_ch, in_ratio, latent_size, out_ratio]
        share = None
        try:
            fid = [float(v) for v in m.fidelity[:size]]
            share = [round(max(0.0, fid[i] - (fid[i - 1] if i else 0.0)), 4) for i in range(size)]
        except Exception:
            pass
        _meta_cache[key] = {'latent_size': size, 'latent_share': share}
    return _meta_cache[key]


def available_models() -> list[dict]:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(MODEL_DIR.glob('*.ts')):
        trained_on, domain, suits = TRAINED_ON.get(p.stem.lower(), ('', '', []))
        try:
            meta = _latent_meta(p)
        except Exception:
            meta = {'latent_size': 0, 'latent_share': None}
        out.append({'id': p.stem, 'name': p.stem.replace('_', ' '), 'size_mb': round(p.stat().st_size / 1e6, 1),
                    'trained_on': trained_on, 'domain': domain, 'suits': suits, **meta})
    return out


def _model_sr(model, default: int) -> int:
    """RAVE exports keep the sample rate on the model or (older v1 exports, e.g. VCTK) on a submodule."""
    sr = getattr(model, 'sr', None)
    if sr is None:
        for _, sub in model.named_modules():
            try:
                sr = int(sub.sr)
                break
            except Exception:
                continue
    return int(sr or default)


def info():
    models = available_models()
    return {'available': bool(models), 'models': models, 'folder': str(MODEL_DIR),
            'note': 'RAVE texture: pretrained encoder → latent → decoder, blended wet/dry.' if models else
                    f'No RAVE models yet. Put a trusted .ts export in {MODEL_DIR} and reload the page.'}


@dataclass
class Job:
    id: str
    state: str = 'queued'
    progress: float = 0.0
    message: str = 'Waiting…'
    url: str | None = None
    result: dict | None = None
    started: float = field(default_factory=time.time)

    def public(self):
        return {'id': self.id, 'state': self.state, 'progress': round(self.progress, 3), 'message': self.message,
                'url': self.url, 'result': self.result}


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def get(job_id):
    return _jobs.get(job_id)


def submit(src: Path, model_id: str, out: Path, url: str, bias=None, scale=None) -> Job:
    path = MODEL_DIR / f'{model_id}.ts'
    if path.parent != MODEL_DIR or not path.is_file():
        raise FileNotFoundError(f'RAVE model "{model_id}" not found in {MODEL_DIR}')
    job = Job(id=uuid.uuid4().hex[:10])
    _jobs[job.id] = job
    if out.exists():  # same stem + model rendered before
        job.state, job.progress, job.url, job.message = 'done', 1.0, url, 'cached'
        return job
    threading.Thread(target=_run, args=(job, src, path, out, url, bias, scale), daemon=True).start()
    return job


def _run(job: Job, src: Path, model_path: Path, out: Path, url: str, bias=None, scale=None):
    """Mono models are run once per channel (as the RAVE docs advise), each with a fresh model so the
    streaming caches start empty. Fixed seed: the decoder fills unused latent dims with noise."""
    try:
        with _lock:
            import torch
            from scipy.signal import resample_poly
            job.state, job.message = 'running', f'RAVE {model_path.stem}: loading…'
            y, sr = audio_io.load(src)
            y = audio_io.to_stereo(y)
            n = y.shape[1]
            rms = lambda a: float(np.sqrt(np.mean(a * a)) + 1e-9)
            # consistent input level, one gain for both channels; never above full scale
            g_in = min(10 ** (INPUT_RMS_DB / 20) / rms(y), 0.98 / (float(np.abs(y).max()) + 1e-9))
            msr = _model_sr(torch.jit.load(str(model_path), map_location='cpu'), sr)
            k = math.gcd(sr, msr)
            wets = []
            for c in range(2):
                torch.manual_seed(c)
                model = torch.jit.load(str(model_path), map_location='cpu').eval()
                x = y[c] * g_in
                if msr != sr:
                    x = resample_poly(x, msr // k, sr // k).astype(np.float32)
                w = _render(model, x, job, c / 2, 0.5, bias, scale)
                if msr != sr:
                    w = resample_poly(w, sr // k, msr // k).astype(np.float32)
                wets.append(w)
            m = min(len(w) for w in wets)
            wet = np.stack([w[:m] for w in wets])
            lag = _lag(wet.mean(0), y.mean(0))
            wet = wet[:, lag:lag + n]
            wet = np.pad(wet, ((0, 0), (0, n - wet.shape[1])))
            wet *= rms(y) / rms(wet)  # same loudness as the dry stem
            wet = 0.98 * np.tanh(wet / 0.98)  # RAVE output is spikier than the stem: soft-limit peaks, keep loudness
            out.parent.mkdir(parents=True, exist_ok=True)
            audio_io.save(out, wet, sr)
        job.state, job.progress, job.url = 'done', 1.0, url
        job.message = f'Texture ready in {time.time() - job.started:.0f} s'
    except Exception as e:
        job.state, job.message = 'error', f'RAVE failed: {e}'


def _render(model, x: np.ndarray, job: Job, p0: float = 0.0, span: float = 1.0, bias=None, scale=None) -> np.ndarray:
    """Streaming exports keep conv caches between calls, so consecutive blocks of one signal are fed in order.
    Latent edit as in the RAVE docs: z = z * scale + bias, per latent dimension, between encode and decode."""
    import torch
    b = torch.tensor(bias, dtype=torch.float32)[None, :, None] if bias else None
    s = torch.tensor(scale, dtype=torch.float32)[None, :, None] if scale else None
    tail = BLOCK * 8  # room for the model's latency
    total = math.ceil((len(x) + tail) / BLOCK) * BLOCK
    x = np.pad(x, (0, total - len(x)))
    step = BLOCK * CHUNK_BLOCKS
    out = []
    with torch.inference_mode():
        for i in range(0, total, step):
            t = torch.from_numpy(x[i:i + step].copy()).reshape(1, 1, -1)
            z = model.encode(t)
            if s is not None:
                z = z * s[:, :z.shape[1]]
            if b is not None:
                z = z + b[:, :z.shape[1]]
            yb = model.decode(z)
            out.append(yb[0].mean(0).numpy())  # older exports (VCTK) decode 2 channels
            job.progress = min(0.99, p0 + span * (i + step) / total)
            job.message = f'RAVE: {int(job.progress * 100)}%'
    wet = np.concatenate(out).astype(np.float32)
    if not np.isfinite(wet).all():
        raise ValueError('model output contains NaN/Inf')
    return wet


def _lag(wet: np.ndarray, dry: np.ndarray, max_lag: int = BLOCK * 8) -> int:
    """The model latency: the lag that best lines the output's loudness envelope up with the input's."""
    from scipy.signal import correlate
    m = min(len(dry), len(wet) - max_lag, 44100 * 30)
    if m < BLOCK:
        return 0
    hop = 16  # compare smoothed loudness envelopes (robust to the timbre change), at 16-sample resolution

    def env(a):
        e = np.convolve(np.abs(a), np.ones(256) / 256, mode='same')[::hop]
        return e - e.mean()

    c = correlate(env(wet[:m + max_lag]), env(dry[:m]), mode='valid', method='fft')
    return int(np.argmax(c[:max_lag // hop + 1])) * hop


# ---------------------------------------------------------------------------------------------------------
# Color-driven latent levels: one latent dimension per channel, picked automatically, rendered at a few
# levels so the browser can crossfade between them live while the color moves.
# ---------------------------------------------------------------------------------------------------------
LEVEL_SHIFTS = [-1.0, 0.0, 1.0]   # pre-rendered levels, in units of the channel's shift (middle = unchanged)
TARGET_EFFECT = 1.6               # aim: going end to end changes the sound by ~1.6 'clearly audible' steps
SWEEP_SHIFT, SWEEP_SECONDS = 2.0, 8
LEVEL_CHUNK = BLOCK * 64          # bigger chunks = far less per-call overhead (~16× realtime on CPU)


def _descriptors(y: np.ndarray, sr: int) -> np.ndarray:
    """[brightness in octaves, loudness in dB/6, noisiness/0.1] so a change of 1 means 'clearly audible'."""
    spec = np.abs(np.fft.rfft(y[: 1 << 18] * np.hanning(min(len(y), 1 << 18)))) + 1e-9
    f = np.fft.rfftfreq(min(len(y), 1 << 18), 1 / sr)
    centroid = float((spec * f).sum() / spec.sum())
    loud = 20 * np.log10(float(np.sqrt(np.mean(y * y))) + 1e-9)
    flat = float(np.exp(np.mean(np.log(spec))) / np.mean(spec))
    return np.array([np.log2(centroid + 1), loud / 6, flat / 0.1])


EFFECT_WORDS = [('darker', 'brighter'), ('softer', 'louder'), ('purer', 'noisier')]


def pick_dimension(model_path: Path, x: np.ndarray, sr: int) -> tuple[int, str, list]:
    """Sweep every latent dim by ±SWEEP_SHIFT on the loudest few seconds; return the dim whose shift changes the
    sound most (monotonically) while the output still follows the input."""
    import torch
    win = sr * SWEEP_SECONDS
    if len(x) > win:
        hop = sr // 2
        energies = [float(np.mean(x[i:i + win] ** 2)) for i in range(0, len(x) - win, hop)]
        i0 = int(np.argmax(energies)) * hop
        x = x[i0:i0 + win]
    n = (len(x) // BLOCK) * BLOCK
    x = x[:n]
    torch.manual_seed(0)
    m = torch.jit.load(str(model_path), map_location='cpu').eval()
    with torch.inference_mode():
        z = m.encode(torch.from_numpy(x.copy())[None, None])
        D = z.shape[1]
        zb = z.repeat(2 * D + 1, 1, 1)
        for d in range(D):
            zb[2 * d, d] -= SWEEP_SHIFT
            zb[2 * d + 1, d] += SWEEP_SHIFT
        y = m.decode(zb).mean(1).numpy()
    base = _descriptors(y[-1], sr)
    env = lambda a: np.convolve(np.abs(a), np.ones(1024) / 1024, 'same')[::256]
    e_in = env(x)
    scores = []
    for d in range(D):
        lo, hi = _descriptors(y[2 * d], sr), _descriptors(y[2 * d + 1], sr)
        delta = hi - lo
        mono = float(np.mean(np.sign(hi - base) == np.sign(base - lo)))  # base sits between lo and hi
        follow = min(np.corrcoef(env(y[2 * d + k])[:len(e_in)], e_in[:len(env(y[2 * d + k]))])[0, 1] for k in (0, 1))
        score = float(np.linalg.norm(delta)) * (0.5 + 0.5 * mono) * (1.0 if follow > 0.25 else 0.3)
        k = int(np.argmax(np.abs(delta)))
        scores.append((score, d, k, 1.0 if delta[k] > 0 else -1.0))
    score, dim, k, sign = max(scores)
    # weak dims get a bigger shift, strong dims a smaller one, so R, G and B feel equally strong;
    # the sign makes 'more color' always mean more of the effect (brighter / louder / noisier) on every channel
    shift = sign * float(np.clip(SWEEP_SHIFT * TARGET_EFFECT / max(score, 1e-3), 1.0, 3.5))
    return dim, f'{EFFECT_WORDS[k][0]} ↔ {EFFECT_WORDS[k][1]}', [round(s[0], 3) for s in sorted(scores, key=lambda t: t[1])], shift


def submit_levels(src: Path, model_id: str, out_dir: Path, url_dir: str, bias=None, scale=None, tag: str = '') -> Job:
    import json
    path = MODEL_DIR / f'{model_id}.ts'
    if path.parent != MODEL_DIR or not path.is_file():
        raise FileNotFoundError(f'RAVE model "{model_id}" not found in {MODEL_DIR}')
    job = Job(id=uuid.uuid4().hex[:10])
    _jobs[job.id] = job
    base = f'{src.stem}__{model_id}__lv2{tag}'  # lv2: direction-normalized levels
    meta_path = out_dir / f'{base}.json'
    if meta_path.exists():
        job.result = json.loads(meta_path.read_text())
        job.state, job.progress, job.url, job.message = 'done', 1.0, job.result['levels'][1], 'cached'
        return job
    threading.Thread(target=_run_levels, args=(job, src, path, out_dir, url_dir, base, bias, scale), daemon=True).start()
    return job


def _run_levels(job: Job, src: Path, model_path: Path, out_dir: Path, url_dir: str, base: str, bias, scale):
    import json
    try:
        with _lock:
            import torch
            from scipy.signal import resample_poly
            job.state, job.message = 'running', f'{model_path.stem}: finding the dimension…'
            y, sr = audio_io.load(src)
            dry = audio_io.to_stereo(y).mean(0)
            n = len(dry)
            rms = lambda a: float(np.sqrt(np.mean(a * a)) + 1e-9)
            g_in = min(10 ** (INPUT_RMS_DB / 20) / rms(dry), 0.98 / (float(np.abs(dry).max()) + 1e-9))
            probe = torch.jit.load(str(model_path), map_location='cpu')
            msr = _model_sr(probe, sr)
            k = math.gcd(sr, msr)
            x = dry * g_in
            if msr != sr:
                x = resample_poly(x, msr // k, sr // k).astype(np.float32)
            dim, effect, scores, amp = pick_dimension(model_path, x, msr)
            job.progress = 0.1
            torch.manual_seed(0)
            model = torch.jit.load(str(model_path), map_location='cpu').eval()
            K = len(LEVEL_SHIFTS)
            shifts = torch.tensor([v * amp for v in LEVEL_SHIFTS], dtype=torch.float32)
            b = torch.tensor(bias, dtype=torch.float32)[None, :, None] if bias else None
            s = torch.tensor(scale, dtype=torch.float32)[None, :, None] if scale else None
            total = math.ceil((len(x) + BLOCK * 8) / BLOCK) * BLOCK
            xp = np.pad(x, (0, total - len(x)))
            outs = []
            with torch.inference_mode():
                for i in range(0, total, LEVEL_CHUNK):
                    z = model.encode(torch.from_numpy(xp[i:i + LEVEL_CHUNK].copy())[None, None])
                    if s is not None:
                        z = z * s[:, :z.shape[1]]
                    if b is not None:
                        z = z + b[:, :z.shape[1]]
                    zb = z.repeat(K, 1, 1)
                    zb[:, dim] += shifts[:, None]
                    outs.append(model.decode(zb).mean(1).numpy())
                    job.progress = 0.1 + 0.85 * min(1.0, (i + LEVEL_CHUNK) / total)
                    job.message = f'{model_path.stem}: {int(job.progress * 100)}%'
            lv = np.concatenate(outs, axis=1).astype(np.float32)  # (K, samples)
            if not np.isfinite(lv).all():
                raise ValueError('model output contains NaN/Inf')
            if msr != sr:
                lv = resample_poly(lv, sr // k, msr // k, axis=1).astype(np.float32)
            lag = _lag(lv[K // 2], dry)
            lv = lv[:, lag:lag + n]
            lv = np.pad(lv, ((0, 0), (0, n - lv.shape[1])))
            lv *= rms(dry) / rms(lv[K // 2])  # one gain for all levels: loudness changes stay part of the effect
            lv = 0.98 * np.tanh(lv / 0.98)
            out_dir.mkdir(parents=True, exist_ok=True)
            urls = []
            for j in range(K):
                audio_io.save(out_dir / f'{base}{j}.wav', lv[j:j + 1], sr)
                urls.append(f'{url_dir}/{base}{j}.wav')
            result = {'model': model_path.stem, 'dim': dim, 'shifts': [round(v * amp, 2) for v in LEVEL_SHIFTS], 'effect': effect,
                      'levels': urls, 'scores': scores}
            (out_dir / f'{base}.json').write_text(json.dumps(result))
            job.result = result
        job.state, job.progress, job.url = 'done', 1.0, urls[K // 2]
        job.message = f'z{dim} ({effect}) ready in {time.time() - job.started:.0f} s'
    except Exception as e:
        job.state, job.message = 'error', f'RAVE failed: {e}'
