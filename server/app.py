"""doodlebeat server: serves the page, splits songs into stems (Demucs), maps a mood to per-instrument
mix settings (mood model), and renders the final mix or stems (pedalboard).

Run from the project folder (the one that holds .venv):
    .venv/bin/python doodlebeat/server/app.py
then open http://localhost:8000
"""
import os
import re
import sys
import time
import uuid
from pathlib import Path

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')  # before torch is imported (Demucs on Apple GPUs)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WORK = ROOT / 'work'
WORK.mkdir(exist_ok=True)
sys.path.insert(0, str(HERE))

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import audio_io  # noqa: E402
import mood_model  # noqa: E402
import render  # noqa: E402
import separate  # noqa: E402
import texture  # noqa: E402

app = FastAPI(title='doodlebeat')
MODEL = mood_model.load_model()


@app.middleware('http')
async def revalidate_page_files(request, call_next):
    """Browsers must re-check page files (html/js/css) so code changes show up on a normal reload.
    Audio under /work never changes once written, so it keeps normal caching."""
    response = await call_next(request)
    if not request.url.path.startswith('/work/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


def _song_dir(song_id: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{10}', song_id) or not (WORK / song_id).is_dir():
        raise HTTPException(404, 'Unknown song. Load the song again.')
    return WORK / song_id


def _save_upload(file: UploadFile, folder: Path, stem: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    raw = folder / f'{stem}_raw{Path(file.filename or "").suffix.lower()[:6]}'
    with open(raw, 'wb') as f:
        while chunk := file.file.read(1 << 20):
            f.write(chunk)
    try:
        return audio_io.to_wav(raw, folder / f'{stem}.wav')
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        raw.unlink(missing_ok=True)


def _work_path(url: str) -> Path:
    """Map a '/work/…' URL from the page to a file, refusing anything outside the work folder."""
    if not url.startswith('/work/'):
        raise HTTPException(400, f'Bad channel source: {url}')
    p = (WORK / url[len('/work/'):]).resolve()
    if WORK.resolve() not in p.parents or not p.is_file():
        raise HTTPException(404, f'Channel audio not found: {url}')
    return p


@app.get('/api/config')
def config():
    return {
        'genres': mood_model.GENRES,
        'instruments': mood_model.INSTRUMENTS,
        'schema': mood_model.SCHEMA,
        'neutral': mood_model.NEUTRAL,
        'model': MODEL.info,
        'latent': {i: MODEL.genre_points(i) for i in mood_model.INSTRUMENTS},
        'separation': {'models': separate.MODELS, 'default': separate.DEFAULT},
        'texture': texture.info(),
    }


@app.post('/api/songs')
def upload_song(file: UploadFile = File(...), model: str = Form(separate.DEFAULT)):
    song_id = uuid.uuid4().hex[:10]
    d = WORK / song_id
    wav = _save_upload(file, d / 'input', 'original')
    job = separate.submit(song_id, wav, d / 'stems', model)
    return {'song_id': song_id, 'job': job.public()}


@app.get('/api/jobs/{job_id}')
def job_status(job_id: str):
    job = separate.get(job_id)
    if not job:
        raise HTTPException(404, 'Unknown job (the server may have restarted). Load the song again.')
    return job.public()


@app.post('/api/songs/{song_id}/channels')
def add_channel(song_id: str, file: UploadFile = File(...)):
    """A replacement or extra channel: converted to 44.1 kHz stereo and fitted to the song length (starts at 0:00)."""
    d = _song_dir(song_id)
    cid = uuid.uuid4().hex[:8]
    wav = _save_upload(file, d / 'channels', cid)
    n = audio_io.load(d / 'input' / 'original.wav')[0].shape[1]
    y, sr = audio_io.load(wav)
    audio_io.save(wav, audio_io.fit_length(audio_io.to_stereo(y), n), sr)
    return {'id': cid, 'url': f'/work/{song_id}/channels/{cid}.wav', 'name': Path(file.filename or 'channel').stem}


class MoodRequest(BaseModel):
    weights: dict[str, float]
    amount: float = 1.0
    instruments: list[str]


@app.post('/api/mood')
def mood(req: MoodRequest):
    out = {}
    for inst in dict.fromkeys(req.instruments):
        s = MODEL.settings(req.weights, req.amount, inst)
        out[inst] = {'settings': s, 'latent': MODEL.embed(s, inst)}
    return out


class RenderChannel(BaseModel):
    src: str
    name: str = 'channel'
    settings: dict
    gain_db: float = 0.0
    muted: bool = False
    texture_src: str | None = None
    texture_wet: float = 0.0
    levels: list[tuple[str, float]] | None = None  # [(src, crossfade weight)] for color-driven RAVE levels


class RenderRequest(BaseModel):
    song_id: str
    channels: list[RenderChannel]
    stems: bool = False


@app.post('/api/render')
def render_mix(req: RenderRequest):
    d = _song_dir(req.song_id)
    n = audio_io.load(d / 'input' / 'original.wav')[0].shape[1]
    channels = [{'path': _work_path(c.src), 'name': re.sub(r'[^A-Za-z0-9_-]+', '_', c.name)[:40] or 'channel',
                 'settings': {**mood_model.NEUTRAL, **c.settings}, 'gain_db': c.gain_db, 'muted': c.muted,
                 'texture': _work_path(c.texture_src) if c.texture_src and c.texture_wet > 0 else None,
                 'levels': [(_work_path(u), float(w)) for u, w in c.levels] if c.levels and c.texture_wet > 0 else None,
                 'texture_wet': min(1.0, max(0.0, c.texture_wet))}
                for c in req.channels]
    (d / 'renders').mkdir(exist_ok=True)
    out = d / 'renders' / f'{time.strftime("%H%M%S")}.{"zip" if req.stems else "wav"}'
    try:
        render.render(channels, n, out, stems=req.stems)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return FileResponse(out, media_type='application/zip' if req.stems else 'audio/wav', filename=out.name)


class TextureRequest(BaseModel):
    song_id: str
    src: str
    model: str
    bias: list[float] | None = None   # per latent dimension, added to z
    scale: list[float] | None = None  # per latent dimension, multiplies z


@app.post('/api/texture')
def apply_texture(req: TextureRequest):
    d = _song_dir(req.song_id)
    src = _work_path(req.src)
    clip = lambda v, lo, hi: [round(min(hi, max(lo, float(x))), 3) for x in (v or [])[:64]]
    bias, scale = clip(req.bias, -5, 5), clip(req.scale, 0, 4)
    bias = bias if any(abs(x) > 1e-6 for x in bias) else None
    scale = scale if any(abs(x - 1) > 1e-6 for x in scale) else None
    tag = ''
    if bias or scale:  # one cached file per latent setting
        import hashlib
        tag = '_' + hashlib.sha1(repr((bias, scale)).encode()).hexdigest()[:8]
    name = f'{src.stem}__{re.sub(r"[^A-Za-z0-9_-]+", "_", req.model)}__v2{tag}.wav'  # v2: stereo, level-normalized
    try:
        job = texture.submit(src, req.model, d / 'texture' / name, f'/work/{req.song_id}/texture/{name}', bias, scale)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return job.public()


class LevelsRequest(BaseModel):
    song_id: str
    src: str
    model: str
    bias: list[float] | None = None   # manual latent shifts for the other dims
    scale: list[float] | None = None


@app.post('/api/levels')
def latent_levels(req: LevelsRequest):
    """Pick the latent dim that changes this stem most, render it at a few levels for live color crossfading."""
    d = _song_dir(req.song_id)
    src = _work_path(req.src)
    clip = lambda v, lo, hi: [round(min(hi, max(lo, float(x))), 3) for x in (v or [])[:64]]
    bias, scale = clip(req.bias, -5, 5), clip(req.scale, 0, 4)
    bias = bias if any(abs(x) > 1e-6 for x in bias) else None
    scale = scale if any(abs(x - 1) > 1e-6 for x in scale) else None
    tag = ''
    if bias or scale:
        import hashlib
        tag = '_' + hashlib.sha1(repr((bias, scale)).encode()).hexdigest()[:8]
    try:
        job = texture.submit_levels(src, re.sub(r'[^A-Za-z0-9_-]+', '_', req.model), d / 'texture',
                                    f'/work/{req.song_id}/texture', bias, scale, tag)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    return job.public()


@app.get('/api/texture/jobs/{job_id}')
def texture_status(job_id: str):
    job = texture.get(job_id)
    if not job:
        raise HTTPException(404, 'Unknown texture job.')
    return job.public()


app.mount('/work', StaticFiles(directory=WORK), name='work')
app.mount('/', StaticFiles(directory=ROOT, html=True), name='site')

if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', 8000))
    print(f'doodlebeat → http://localhost:{port}')
    uvicorn.run(app, host='127.0.0.1', port=port)
