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

1. **Load a track**: use the top bar, drop a file anywhere on the page, or click "Demo beat". The app analyzes the track in the browser for beats, BPM, key, the chord in each bar, the melody pitch on each beat, energy, and onsets. The track's waveform and chords appear in the strip under the top bar.
2. **Paint the sound**: this is the main step. There are three channel strips (Red · Energy, Green · Flow, Blue · Depth). Each strip has an instrument picker that draws from a pool of 6 instruments: Drums, Violin, Trumpet, Piano, Guitar, and Bass. Picking an instrument that's already on another strip swaps the two. Each strip also has a vertical fader. The faders, the glowing color orb, and the color pad under it are all linked, so moving any one of them updates the others.
   - **Red · Energy**: rhythmic stabs, accents and a higher register.
   - **Green · Flow**: melody and arpeggios that follow the song's harmony.
   - **Blue · Depth**: long, low, spacious tones with more reverb.
   - The **intensity** of a channel sets how much its instrument contributes. It controls volume, and as it rises the instrument also gets busier.
   - The **mixed color** sets the global mood. Hue picks the chord color (add9, 6, 7, or 7+9), and lightness and saturation set tone brightness and reverb.
3. **Spectral view**: the changes are shown as a chain: Input → + Red → + Green → + Blue (= final mix). Each row is tinted in its channel's color and has a labelled waveform and log-frequency spectrogram. It also shows loudness and brightness, and how much each changed from the row before. The consolidated plot at the end shows the original in gray and each channel's added energy in its own color, with toggles to show or hide each layer. To zoom, scroll or pinch; to pan, drag; double-click resets the view. The waveforms always show the whole track, with a window marking the zoomed range that you can drag to move the zoom.

## Color → feeling mapping: where it comes from

The mapping in `js/semantics.js` (hue ranges, mood names, chord extensions, the tone and reverb formulas) is a **hand-tuned heuristic**. It was not fitted to data. It loosely follows these findings:

- Palmer, Schloss, Xu & Prado-León (2013), *Music–color associations are mediated by emotion*, PNAS 110(22). People pair faster, major-key music with lighter, more saturated, yellower colors, and slower, minor-key music with darker, desaturated, bluer colors. This is the basis for blue meaning melancholic or minor-leaning and yellow meaning sunny. It is also why lightness and saturation control brightness and reverb.
- Whiteford, Schloss, Helwig & Palmer (2018), *Color, music, and emotion: Bach to the blues*, i-Perception 9(6). This study replicates the emotion-mediated music↔color link across genres.
- Valdez & Mehrabian (1994), *Effects of color on emotions*, J. Exp. Psychology: General 123(4). Saturation and brightness predict arousal and pleasantness more strongly than hue does.
- Jonauskaite et al. (2020), *Universal patterns in color-emotion associations*, Psychological Science 31(10). Red is linked to love and anger (high arousal) and yellow to joy across 30 nations. This is the basis for red meaning fiery or energetic.

Some choices have **no empirical source** and are common music-production conventions or my own choices. These are the specific mood labels ("Fiery", "Dreamy", …), the chord colors (add9 sounds bright, 7ths moody, 6ths sweet, 7+9 lush), and the channel roles (Red = Energy, Green = Flow, Blue = Depth). The AI plugin stage is the natural place to replace them with a mapping learned from data.

## Architecture / plugin points

| File | Role | Swap for |
| --- | --- | --- |
| `js/analysis.js` | FFT, onset envelope, DP beat tracker, key, chords | librosa / madmom / basic-pitch backend |
| `js/semantics.js` | color → roles & mood | AI color→music mapping / text prompt |
| `js/arranger.js` | per-16th note generation for each instrument | symbolic AI model / MusicGen-style generation |
| `js/instruments.js` | Web Audio synths | samples, soundfonts, neural timbre |
| `js/engine.js` | live scheduler + offline WAV render + per-channel stem render | — |
| `js/visualize.js` | stage waveforms, spectrograms, channel-colored composite | — |
