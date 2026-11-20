# doodlebeat

Select a song, set the mood, press play.

doodlebeat splits a song into stems, and each stem becomes a channel. A mood is a blend of genres that you pick with a color. A mood model turns that blend into mix settings for each instrument: EQ, compression, saturation, reverb, stereo width and level. You hear the result live and can render the final mix or the processed stems.

## Run

From the project folder (the one that contains `.venv`):

```bash
.venv/bin/python -m pip install fastapi "uvicorn[standard]" python-multipart pedalboard   # once; demucs + torch are already in .venv
.venv/bin/python doodlebeat/server/app.py
# open http://localhost:8000
```

The server needs `ffmpeg` on the PATH to read MP3 or M4A files.

## The pipeline

1. **Select a song.** Use the top bar or drop a file anywhere on the page. The server splits it with Demucs, using the same code as `notebooks & huggingfaces/1 · Split a song into stems (Demucs).ipynb`. The default model is `htdemucs_6s` (vocals, drums, bass, guitar, piano, other). The dropdown also offers `htdemucs` (4 stems, fast) and `htdemucs_ft` (4 stems, cleanest). While the split runs, Play uses the original song. When the stems are ready, playback switches to them.
2. **The band.** Each stem is a channel. For each channel you can:
   - Set its instrument type, which decides the mood profile it gets.
   - Mute, solo and set its level.
   - **Replace** it with another recording (⇄) and go back to the original stem (↺).
   - **Add** more channels.

   New audio starts at 0:00 and is trimmed or padded to the song's length.
3. **Set the mood.** Each genre (Lo-fi, Jazz, Rock, EDM, Hip-hop, Cinematic) has an anchor on the color pad. Each point on the pad is a blend of nearby genres. Pure colors give full strength, and the strength fades toward white or black, where the song is left as recorded. You can fine-tune the blend and the strength with the bars.
   - **Spectrum** opens the waveform/spectrogram view below the stage. It shows the original, each channel with its mood, the mood mix, and a consolidated view colored by channel.
4. **The mood, per instrument.** For each channel this section shows:
   - The EQ curve, drawn over the live spectrum before and after processing.
   - Bars for compression, saturation, reverb, width and level.
   - The **genre map**, which shows where the current mood sits between the genres for that instrument.
   - **Hand EQ:** drag a band's dot up or down to change its gain, and left or right to move its frequency (up to 2 octaves either way). Double-click a dot to reset that band. Your edits are offsets on top of the mood, so the mood can keep changing underneath them. The dashed curve shows what the mood alone would do. **Reset EQ** clears all edits for the selected channel.
5. **Play, compare, export.** The *Mood* switch compares the mood with the song as recorded. **Render mix** renders a full-quality WAV on the server with pedalboard. **Stems for GarageBand** gives a ZIP of the processed stems. They are aligned at 0:00, so you can drop them onto GarageBand tracks. GarageBand can't be controlled from code, so it only gets these files.

## Mood model (placeholder)

`server/mood_model.py` takes a genre blend and a strength and returns one settings vector per instrument (see `SCHEMA`). The current model, `PlaceholderMoodModel`, uses **hand-tuned** genre × instrument presets and blends them linearly. Its genre map is a PCA of those presets. Nothing in it is learned yet.

A trained model only needs the same three methods: `settings`, `embed` and `genre_points`. Select it with `DOODLEBEAT_MODEL`. The plan:

- **v1:** collect genre-tagged songs and split them with Demucs, so each stem is labelled by genre and instrument. Measure each stem's ⅓-octave spectrum, crest factor, loudness range and stereo width. Then fit EQ gains and compression to the difference from that instrument's average across all genres.
- **v2:** an instrument-conditioned VAE over those features. A mood is the weighted blend of genre centroids in the latent space, decoded into settings. Train it through differentiable DSP (e.g. `dasp-pytorch`).

## RAVE texture

Each channel can be passed through a pretrained RAVE model. The integration follows the RAVE docs (<https://acids-rave.readthedocs.io>):

- **Streaming exports:** consecutive blocks are fed in order, so the convolution caches carry over between blocks and there are no clicks.
- **Stereo:** mono models run once per channel.
- **Input level:** every stem goes in at −20 dBFS RMS, because RAVE reacts strongly to input level.
- **Repeatability:** a fixed seed, since the decoder fills unused latent dimensions with noise.
- **Output level:** matched to the dry stem's loudness, with peaks soft-limited.

A model can only re-voice a stem in the sound world it was trained on. The dropdown marks models that suit the channel's instrument with ✓. None of the current models suits drums or bass.

How it works: This is inference only: the model's encoder turns the stem into a latent, its decoder turns it back into audio, and the result is blended wet/dry before the mood chain. The model's latency is removed by cross-correlation. To use a model, put a trusted TorchScript export (`.ts`) in `doodlebeat/models/rave/` and reload the page. Only use files from a source you trust, because TorchScript can run code. Models are available at <https://acids-ircam.github.io/rave_models_download>.

## Files

| File | Role |
| --- | --- |
| `server/app.py` | FastAPI: serves the page, `/api/songs`, `/api/jobs`, `/api/mood`, `/api/render`, `/api/texture` |
| `server/separate.py` | Demucs separation jobs |
| `server/mood_model.py` | genres, settings schema, placeholder mood model (**plugin point**) |
| `server/render.py` | pedalboard render (mix or stems) |
| `server/texture.py` | RAVE texture jobs |
| `js/dsp.js` | live Web Audio chain for each channel (formulas mirror `render.py`) |
| `js/engine.js` | playback of the channels, offline renders for the visuals |
| `js/mood.js` | color pad → genre blend |
| `js/moodviz.js` | EQ/spectrum scope, settings bars, genre map |
| `js/visualize.js` | spectral view |
| `js/analysis.js` | BPM, key, chords of the original (shown under the waveform) |

Uploaded songs, stems and renders are stored in `doodlebeat/work/`, which is ignored by git.
