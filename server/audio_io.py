"""Audio file helpers shared by the server modules. Everything is stored as 44.1 kHz stereo WAV."""
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100


def to_wav(src: Path, dst: Path, sr: int = SR, channels: int = 2) -> Path:
    """Convert any audio/video file to WAV with ffmpeg (same approach as the Demucs notebook)."""
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-vn',
           '-ac', str(channels), '-ar', str(sr), '-c:a', 'pcm_s16le', str(dst)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True)
        ok = r.returncode == 0
    except FileNotFoundError:  # no ffmpeg: soundfile reads wav/flac/ogg/mp3 directly
        ok = False
    if not ok or not dst.exists() or dst.stat().st_size < 2000:
        try:
            y, in_sr = load(src)
        except Exception as e:
            raise ValueError(f'Could not read "{src.name}". Use WAV, MP3, FLAC, M4A or OGG.') from e
        if in_sr != sr:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(in_sr, sr)
            y = resample_poly(y, sr // g, in_sr // g, axis=1).astype(np.float32)
        save(dst, to_stereo(y), sr)
    return dst


def load(path) -> tuple[np.ndarray, int]:
    """Returns (audio [channels, samples] float32, sample_rate)."""
    y, sr = sf.read(str(path), dtype='float32', always_2d=True)
    return y.T.copy(), sr


def save(path, y: np.ndarray, sr: int = SR, subtype: str = 'PCM_16') -> Path:
    sf.write(str(path), np.clip(np.asarray(y, dtype=np.float32).T, -1, 1), sr, subtype=subtype)
    return Path(path)


def to_stereo(y: np.ndarray) -> np.ndarray:
    if y.shape[0] == 1:
        return np.repeat(y, 2, axis=0)
    return y[:2]


def fit_length(y: np.ndarray, n: int) -> np.ndarray:
    """Pad with silence or trim so a replacement/added channel lines up with the song (both start at 0:00)."""
    if y.shape[1] >= n:
        return y[:, :n]
    return np.pad(y, ((0, 0), (0, n - y.shape[1])))
