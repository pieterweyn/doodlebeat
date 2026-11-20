"""Stem separation with Demucs, run as background jobs so the page can poll progress.

Same model and API as "notebooks & huggingfaces/1 · Split a song into stems (Demucs).ipynb".
"""
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import audio_io

MODELS = [
    {'id': 'htdemucs_6s', 'label': '6 stems · + guitar & piano'},
    {'id': 'htdemucs', 'label': '4 stems · fast'},
    {'id': 'htdemucs_ft', 'label': '4 stems · cleanest, 4× slower'},
]
DEFAULT = 'htdemucs_6s'
ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']


@dataclass
class Job:
    id: str
    song_id: str
    model: str
    state: str = 'queued'  # queued | loading | running | done | error
    progress: float = 0.0
    message: str = 'Waiting for the separator…'
    stems: list = field(default_factory=list)
    started: float = field(default_factory=time.time)

    def public(self):
        return {'id': self.id, 'song_id': self.song_id, 'model': self.model, 'state': self.state,
                'progress': round(self.progress, 3), 'message': self.message, 'stems': self.stems}


_jobs: dict[str, Job] = {}
_separators = {}
_gpu = threading.Lock()  # one separation at a time: the GPU is shared


def _device():
    import torch
    if torch.cuda.is_available():
        return 'cuda'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def _separator(model: str, device: str):
    from demucs.api import Separator
    key = (model, device)
    if key not in _separators:
        _separators[key] = Separator(model=model, device=device, shifts=1, progress=False)
    return _separators[key]


def submit(song_id: str, wav: Path, out_dir: Path, model: str = DEFAULT) -> Job:
    if model not in {m['id'] for m in MODELS}:
        model = DEFAULT
    job = Job(id=uuid.uuid4().hex[:10], song_id=song_id, model=model)
    _jobs[job.id] = job
    threading.Thread(target=_run, args=(job, wav, out_dir), daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def _run(job: Job, wav: Path, out_dir: Path):
    try:
        with _gpu:
            import torch
            job.state, job.message = 'loading', f'Loading {job.model} (the first time downloads it)…'
            y, sr = audio_io.load(wav)
            device = _device()
            try:
                stems, out_sr = _separate(job, torch.from_numpy(y), sr, device)
            except RuntimeError as e:  # some ops are missing on MPS for some shapes: retry on the CPU
                if device == 'cpu':
                    raise
                job.message = f'{device} failed ({e.__class__.__name__}), retrying on the CPU…'
                stems, out_sr = _separate(job, torch.from_numpy(y), sr, 'cpu')
        out_dir.mkdir(parents=True, exist_ok=True)
        names = [k for k in ORDER if k in stems] + [k for k in stems if k not in ORDER]
        for k in names:
            audio_io.save(out_dir / f'{k}.wav', stems[k], out_sr)
        rel = out_dir.relative_to(out_dir.parents[1])  # <song_id>/stems
        job.stems = [{'name': k, 'url': f'/work/{rel.as_posix()}/{k}.wav'} for k in names]
        job.state, job.progress = 'done', 1.0
        job.message = f'{len(names)} stems ready in {time.time() - job.started:.0f} s'
    except Exception as e:  # report any failure to the page instead of dying silently
        job.state, job.message = 'error', f'Separation failed: {e}'


def _separate(job: Job, wav, sr: int, device: str):
    sep = _separator(job.model, device)
    n = wav.shape[-1] * sep.samplerate / sr

    def on_progress(d):
        models = d.get('models', 1) or 1
        done = d.get('model_idx_in_bag', 0) + min(1.0, d.get('segment_offset', 0) / max(1, n))
        job.progress = max(job.progress, min(0.99, done / models))

    sep.update_parameter(callback=on_progress)
    job.state, job.message = 'running', f'Splitting into stems on {device}…'
    _, stems = sep.separate_tensor(wav, sr)
    return {k: v.cpu().numpy() for k, v in stems.items()}, sep.samplerate
