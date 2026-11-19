import { analyzeBuffer } from './analysis.js';
import { Engine } from './engine.js';
import { INSTRUMENT_LIST } from './instruments.js';
import { CHANNELS, CHANNEL_ORDER, moodFromLevels, levelsToHex } from './semantics.js';
import { makeDemoBeat } from './demo.js';
import { encodeWav } from './wav.js';
import { Visualizer } from './visualize.js';

const $ = (id) => document.getElementById(id);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

const state = { buffer: null, analysis: null, name: '', assign: { guitar: 'R', bass: 'G' }, levels: { R: 0.7, G: 0.55, B: 0.4 }, baseVol: 0.8, loop: true };
const engine = new Engine();
const viz = new Visualizer($('viz'), $('viz-status'), $('viz-toolbar'));
viz.onSeek = (frac) => state.buffer && engine.seek(frac * state.buffer.duration);
let waveImg = null, currentBar = -1, vizTimer = null;

// ---------- Source: load / drop / demo ----------
const fileInput = $('file-input');
$('load-btn').addEventListener('click', () => fileInput.click());
$('lane-empty').addEventListener('click', () => fileInput.click());
$('lane').addEventListener('keydown', (e) => { if (!state.buffer && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadFile(f); fileInput.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files?.[0];
  if (f) loadFile(f);
});
$('demo-btn').addEventListener('click', async () => {
  setStatus('Synthesizing demo beat…');
  await setBase(await makeDemoBeat(), 'Demo beat');
});

function setStatus(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }

async function loadFile(file) {
  setStatus(`Decoding ${file.name}…`);
  try {
    const buf = await engine.context.decodeAudioData(await file.arrayBuffer());
    await setBase(buf, file.name);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't decode “${file.name}”. Try WAV or MP3.`, true);
  }
}

async function setBase(buf, name) {
  engine.stop(); updatePlayBtn();
  const A = await analyzeBuffer(buf, (p) => setStatus(`Listening… ${Math.round(p * 100)}%`));
  Object.assign(state, { buffer: buf, analysis: A, name });
  engine.load(buf, A);
  setStatus('');
  renderTrackInfo();
  syncEngine();
}

function renderTrackInfo() {
  const A = state.analysis;
  $('lane-empty').classList.add('hidden');
  $('track-info').classList.remove('hidden');
  $('file-name').textContent = state.name;
  $('file-name').title = state.name;
  $('chips').innerHTML = [`${A.bpm} BPM`, A.key.name, fmt(A.duration)].map((c) => `<span class="chip">${c}</span>`).join('');
  $('t-dur').textContent = fmt(A.duration);
  $('chord-strip').innerHTML = A.chords.map((c) => `<span>${c.name}</span>`).join('');
  currentBar = -1;
  drawWave();
}

// ---------- Track waveform ----------
const canvas = $('wave');
function drawWave() {
  if (!state.buffer) return;
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  canvas.width = w; canvas.height = h;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const g = off.getContext('2d'), data = state.buffer.getChannelData(0), A = state.analysis;
  const spp = data.length / w;
  g.fillStyle = 'rgba(255,255,255,.45)';
  for (let x = 0; x < w; x++) {
    let mn = 0, mx = 0;
    const a = Math.floor(x * spp), b = Math.min(data.length, Math.floor((x + 1) * spp));
    for (let i = a; i < b; i += 8) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    g.fillRect(x, h / 2 - mx * h * 0.45, 1, Math.max(1, (mx - mn) * h * 0.45));
  }
  A.beatTimes.forEach((t, b) => {
    const down = (b + A.barShift) % 4 === 0;
    g.fillStyle = down ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.06)';
    g.fillRect((t / A.duration) * w, 0, down ? 1.5 * dpr : dpr, h);
  });
  waveImg = off;
}
canvas.addEventListener('click', (e) => {
  if (!state.buffer) return;
  const r = canvas.getBoundingClientRect();
  engine.seek(((e.clientX - r.left) / r.width) * state.buffer.duration);
});

// ---------- Orb: reacts to the live output (loudness → size/glow, ring = live waveform) ----------
const orbWrap = document.querySelector('.orb-wrap'), orbCanvas = $('orb-wave');
let orbLevel = 0, scopeBuf = null;
function drawOrb() {
  const playing = engine.playing && engine.analyser;
  let rms = 0;
  if (playing) {
    scopeBuf ??= new Float32Array(engine.analyser.fftSize);
    engine.analyser.getFloatTimeDomainData(scopeBuf);
    for (let i = 0; i < scopeBuf.length; i++) rms += scopeBuf[i] * scopeBuf[i];
    rms = Math.sqrt(rms / scopeBuf.length);
  }
  // fast attack, slower release so beats "punch"
  const target = Math.min(1, rms * 3.2);
  orbLevel += (target - orbLevel) * (target > orbLevel ? 0.55 : 0.12);
  orbWrap.style.setProperty('--level', orbLevel.toFixed(3));

  const dpr = window.devicePixelRatio || 1, W = orbCanvas.clientWidth * dpr, H = orbCanvas.clientHeight * dpr;
  if (orbCanvas.width !== W) { orbCanvas.width = W; orbCanvas.height = H; }
  const g = orbCanvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const orbR = (document.getElementById('swatch').clientWidth / 2) * (1 + orbLevel * 0.05) * dpr;
  const r0 = orbR + 14 * dpr, amp = 12 * dpr, n = 128;
  const color = levelsToHex(state.levels);
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 8 * dpr;
  g.globalAlpha = playing ? 0.55 : 0.2;
  g.beginPath();
  // Average each point over a window of samples so the ring ripples gently instead of spiking
  const win = playing ? Math.floor(scopeBuf.length / n) : 1;
  for (let i = 0; i <= n; i++) {
    const k = i % n, ang = (k / n) * Math.PI * 2 - Math.PI / 2;
    let s = 0;
    if (playing) { const j0 = k * win; for (let j = 0; j < win; j++) s += scopeBuf[j0 + j]; s /= win; }
    const r = r0 + Math.max(-1, Math.min(1, s * 2)) * amp;
    const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  g.globalAlpha = 1;
  g.shadowBlur = 0;
}

function frame() {
  drawOrb();
  if (state.buffer && waveImg) {
    const g = canvas.getContext('2d'), pos = engine.position, A = state.analysis;
    const x = (pos / A.duration) * canvas.width;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(waveImg, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = levelsToHex(state.levels);
    g.fillRect(0, 0, x, canvas.height);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#fff';
    g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), canvas.height);
    $('t-cur').textContent = fmt(pos);
    viz.drawPlayhead(pos / A.duration);
    let b = 0;
    while (b < A.beatTimes.length - 1 && A.beatTimes[b + 1] <= pos) b++;
    const bar = engine.playing ? Math.min(A.chords.length - 1, Math.floor((b + A.barShift) / 4)) : -1;
    if (bar !== currentBar) {
      const spans = $('chord-strip').children;
      spans[currentBar]?.classList.remove('now');
      spans[bar]?.classList.add('now');
      currentBar = bar;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Channel strips: instrument + vertical fader ----------
const instOf = (ch) => Object.keys(state.assign).find((id) => state.assign[id] === ch);

function renderStrips() {
  const wrap = $('strips');
  wrap.innerHTML = '';
  for (const ch of CHANNEL_ORDER) {
    const C = CHANNELS[ch];
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.id = `strip-${ch}`;
    strip.style.setProperty('--c', C.color);
    strip.title = C.blurb;
    strip.innerHTML = `
      <div class="strip-head"><span class="strip-name">${C.name}</span><span class="strip-meaning">${C.meaning}</span></div>
      <div class="inst-select"><select aria-label="${C.name} channel instrument">
        <option value="">— none —</option>
        ${INSTRUMENT_LIST.map((i) => `<option value="${i.id}">${i.icon} ${i.name}</option>`).join('')}
      </select></div>
      <div class="fader" role="slider" tabindex="0" aria-label="${C.name} intensity" aria-valuemin="0" aria-valuemax="100">
        <div class="fader-fill"></div><div class="fader-thumb"></div>
      </div>
      <div class="strip-val"></div>`;
    strip.querySelector('select').addEventListener('change', (e) => assignInstrument(ch, e.target.value));
    bindFader(strip.querySelector('.fader'), ch);
    wrap.appendChild(strip);
  }
  syncStrips();
}

function syncStrips() {
  for (const ch of CHANNEL_ORDER) {
    const strip = $(`strip-${ch}`), id = instOf(ch);
    strip.querySelector('select').value = id || '';
    strip.classList.toggle('empty', !id);
  }
}

// Picking an instrument already on another channel swaps the two.
function assignInstrument(ch, id) {
  const prev = instOf(ch), other = id ? state.assign[id] : null;
  if (prev) delete state.assign[prev];
  if (id) {
    if (other && prev) state.assign[prev] = other;
    state.assign[id] = ch;
  }
  syncStrips();
  syncEngine();
}

function bindFader(el, ch) {
  const setFromY = (clientY) => {
    const r = el.getBoundingClientRect();
    setLevel(ch, clamp01(1 - (clientY - r.top) / r.height));
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); el.focus(); setFromY(e.clientY); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) setFromY(e.clientY); });
  el.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    setLevel(ch, clamp01(state.levels[ch] + step));
  });
}

function setLevel(ch, v) {
  state.levels[ch] = v;
  updateColor();
  syncEngine();
}

// ---------- Color ----------
function updateColor(fromPad = false) {
  const hex = levelsToHex(state.levels), mood = moodFromLevels(state.levels);
  const { R, G, B } = state.levels;
  $('mood-label').textContent = mood.label;
  $('mood-desc').textContent = mood.desc;
  $('swatch').title = hex.toUpperCase();
  $('swatch').style.color = 0.2126 * R + 0.7152 * G + 0.0722 * B > 0.5 ? '#111' : '#fff';
  document.documentElement.style.setProperty('--mix', hex);
  if (!fromPad) { const [x, y] = rgbToPad(state.levels); placeMarker(x, y); }
  for (const ch of CHANNEL_ORDER) {
    const strip = $(`strip-${ch}`);
    if (!strip) continue;
    const pct = Math.round(state.levels[ch] * 100);
    strip.style.setProperty('--v', state.levels[ch]);
    strip.querySelector('.fader').setAttribute('aria-valuenow', pct);
    strip.querySelector('.strip-val').textContent = `${pct}%`;
  }
}

// Color pad: x = hue, y = white (top) → pure hue (middle) → black (bottom)
const pad = $('color-pad'), marker = $('pad-marker');
function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
function padToRgb(x, y) {
  return y < 0.5 ? hsvToRgb(x * 360, y * 2, 1) : hsvToRgb(x * 360, 1, 1 - (y - 0.5) * 2);
}
function rgbToPad({ R, G, B }) {
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
    if (h < 0) h += 360;
  }
  const s = max ? d / max : 0, v = max;
  return [h / 360, 1 - v >= 1 - s ? 0.5 + 0.5 * (1 - v) : 0.5 * s];
}
function drawPad() {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(pad.clientWidth * dpr)), H = Math.max(1, Math.round(pad.clientHeight * dpr));
  pad.width = W; pad.height = H;
  const g = pad.getContext('2d'), img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, gg, b] = padToRgb(x / (W - 1), y / (H - 1)), p = (y * W + x) * 4;
    img.data[p] = r * 255; img.data[p + 1] = gg * 255; img.data[p + 2] = b * 255; img.data[p + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
function placeMarker(x, y) { marker.style.left = `${x * 100}%`; marker.style.top = `${y * 100}%`; }
function pickFromPad(e) {
  const r = pad.getBoundingClientRect();
  const x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
  const [R, G, B] = padToRgb(x, y);
  state.levels = { R, G, B };
  placeMarker(x, y);
  updateColor(true);
  syncEngine();
}
pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); pickFromPad(e); });
pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) pickFromPad(e); });

// ---------- Engine / visualization sync ----------
function syncEngine() {
  const tracks = Object.entries(state.assign).map(([id, channel]) => ({ id, channel, level: state.levels[channel] }));
  engine.setConfig({ tracks, mood: moodFromLevels(state.levels), baseVol: state.baseVol, loop: state.loop });
  $('play-btn').disabled = $('export-btn').disabled = !state.buffer;
  scheduleViz();
}

// The spectral view only computes while it's expanded.
$('studio').addEventListener('toggle', () => { if ($('studio').open) { viz.redraw(); scheduleViz(0); } });

function scheduleViz(delay = 400) {
  if (!state.buffer || !$('studio').open) return;
  clearTimeout(vizTimer);
  $('viz-status').textContent = 'Updating…';
  vizTimer = setTimeout(() => {
    const tracks = {};
    for (const [id, ch] of Object.entries(state.assign)) {
      const inst = INSTRUMENT_LIST.find((i) => i.id === id);
      tracks[ch] = { id, name: inst.name, icon: inst.icon, level: state.levels[ch] };
    }
    viz.update({ engine, buffer: state.buffer, name: state.name, tracks, baseVol: state.baseVol, mood: moodFromLevels(state.levels) })
      .catch((err) => { console.error(err); $('viz-status').textContent = 'Visualization failed (see console).'; });
  }, delay);
}

// ---------- Transport ----------
function updatePlayBtn() {
  const btn = $('play-btn');
  btn.textContent = engine.playing ? '❚❚' : '▶';
  btn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
  document.body.classList.toggle('playing', engine.playing);
}
function togglePlay() {
  if (!state.buffer) return;
  if (engine.playing) engine.pause(); else engine.play(engine.pausedAt);
  updatePlayBtn();
}
engine.onEnded = updatePlayBtn;
$('play-btn').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'BUTTON', 'SELECT'].includes(e.target.tagName) && !e.target.classList.contains('fader')) { e.preventDefault(); togglePlay(); }
});
$('base-vol').addEventListener('input', (e) => { state.baseVol = e.target.value / 100; syncEngine(); });
$('loop').addEventListener('change', (e) => { state.loop = e.target.checked; syncEngine(); });
$('export-btn').addEventListener('click', async () => {
  const btn = $('export-btn');
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const url = URL.createObjectURL(encodeWav(await engine.render()));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.name.replace(/\.[^.]+$/, '')}-doodlebeat-${levelsToHex(state.levels).slice(1)}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } finally {
    btn.disabled = false; btn.textContent = '⤓ Export WAV';
  }
});

window.addEventListener('resize', () => { drawWave(); viz.redraw(); drawPad(); updateColor(); });

// ---------- init ----------
renderStrips();
drawPad();
updateColor();
syncEngine();
