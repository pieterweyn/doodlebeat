# doodlebeat

Upload a beat, pick three instruments, and use color to re-arrange it.

## Run

```bash
cd doodlebeat
python3 -m http.server 8000
# open http://localhost:8000
```

There are no dependencies and no build step. It uses vanilla JS ES modules and the Web Audio API. The page needs to be served over HTTP, because ES modules don't load from `file://`.

## How it works

1. **Base track**: you upload any audio file, or use the built-in demo beat. The app analyzes it in the browser for beats, BPM, key, the chord in each bar, the melody pitch on each beat, energy, and onsets.
2. **Instruments**: you choose 3 of the 4 (Drums, Violin, Trumpet, Piano). Each one is assigned a color channel. Click its badge to swap channels.
3. **Color = semantics**:
   - **Red · Energy**: rhythmic stabs, accents and a higher register.
   - **Green · Flow**: melody and arpeggios that follow the song's harmony.
   - **Blue · Depth**: long, low, spacious tones with more reverb.
   - The **intensity** of a channel sets how much its instrument contributes. It controls volume, and as it rises the instrument also gets busier.
   - The **mixed color** sets the global mood. Hue picks the chord color (add9, 6, 7, or 7+9), and lightness and saturation set tone brightness and reverb.

## Architecture / plugin points

| File | Role | Swap for |
|---|---|---|
| `js/analysis.js` | FFT, onset envelope, DP beat tracker, key, chords | librosa / madmom / basic-pitch backend |
| `js/semantics.js` | color → roles & mood | AI color→music mapping / text prompt |
| `js/arranger.js` | per-16th note generation for each instrument | symbolic AI model / MusicGen-style generation |
| `js/instruments.js` | Web Audio synths | samples, soundfonts, neural timbre |
| `js/engine.js` | live scheduler + offline WAV render | — |
