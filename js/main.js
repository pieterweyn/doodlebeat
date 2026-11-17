import { analyzeBuffer } from './analysis.js';
import { Engine } from './engine.js';
import { INSTRUMENT_LIST } from './instruments.js';
import { CHANNELS, CHANNEL_ORDER, moodFromLevels, levelsToHex, hexToLevels } from './semantics.js';
import { makeDemoBeat } from './demo.js';
import { encodeWav } from './wav.js';

const $ = (id) => document.getElementById(id);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const DEFAULT_HINT = 'Each pick gets a color channel: first → Red, then Green, then Blue. Tap a badge to swap colors.';

const state = { buffer: null, analysis: null, name: '', assign: {}, levels: { R: 0.7, G: 0.55, B: 0.4 }, baseVol: 0.8, loop: true };
const engine = new Engine();
let waveImg = null, currentBar = -1;

// ---------- 1. Upload ----------
const dz = $('dropzone'), fileInput = $('file-input');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); });
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadFile(f); fileInput.value = ''; });
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
  setStatus('Analyzing…');
  const A = await analyzeBuffer(buf, (p) => setStatus(`Analyzing tempo, key & harmony… ${Math.round(p * 100)}%`));
  Object.assign(state, { buffer: buf, analysis: A, name });
  engine.load(buf, A);
  setStatus('');
  renderTrackInfo();
  syncEngine();
}

function renderTrackInfo() {
  const A = state.analysis;
  $('track-info').classList.remove('hidden');
  $('file-name').textContent = state.name;
  $('chips').innerHTML = [`${A.bpm} BPM`, A.key.name, fmt(A.duration)].map((c) => `<span class="chip">${c}</span>`).join('');
  $('t-dur').textContent = fmt(A.duration);
  $('chord-strip').innerHTML = A.chords.map((c) => `<span>${c.name}</span>`).join('');
  currentBar = -1;
  drawWave();
}

// ---------- Waveform ----------
const canvas = $('wave');
function drawWave() {
  if (!state.buffer) return;
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  canvas.width = w; canvas.height = h;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const g = off.getContext('2d'), data = state.buffer.getChannelData(0), A = state.analysis;
  const spp = data.length / w;
  g.fillStyle = '#5a6070';
  for (let x = 0; x < w; x++) {
    let mn = 0, mx = 0;
    const a = Math.floor(x * spp), b = Math.min(data.length, Math.floor((x + 1) * spp));
    for (let i = a; i < b; i += 8) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    g.fillRect(x, h / 2 - mx * h * 0.45, 1, Math.max(1, (mx - mn) * h * 0.45));
  }
  A.beatTimes.forEach((t, b) => {
    const down = (b + A.barShift) % 4 === 0;
    g.fillStyle = down ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.07)';
    g.fillRect((t / A.duration) * w, 0, down ? 1.5 * dpr : dpr, h);
  });
  waveImg = off;
}
window.addEventListener('resize', drawWave);
canvas.addEventListener('click', (e) => {
  if (!state.buffer) return;
  const r = canvas.getBoundingClientRect();
  engine.seek(((e.clientX - r.left) / r.width) * state.buffer.duration);
});

function frame() {
  if (state.buffer && waveImg) {
    const g = canvas.getContext('2d'), pos = engine.position, A = state.analysis;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(waveImg, 0, 0);
    const x = (pos / A.duration) * canvas.width;
    g.fillStyle = 'rgba(255,255,255,.06)';
    g.fillRect(0, 0, x, canvas.height);
    g.fillStyle = levelsToHex(state.levels);
    g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), canvas.height);
    $('t-cur').textContent = fmt(pos);
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

// ---------- 2. Instruments ----------
function renderInstruments() {
  const grid = $('inst-grid');
  grid.innerHTML = '';
  for (const inst of INSTRUMENT_LIST) {
    const ch = state.assign[inst.id];
    const btn = document.createElement('button');
    btn.className = 'inst' + (ch ? ' on' : '');
    btn.setAttribute('aria-pressed', String(!!ch));
    if (ch) btn.style.setProperty('--c', CHANNELS[ch].color);
    btn.innerHTML = `<span class="icon">${inst.icon}</span><span class="name">${inst.name}</span><span class="blurb">${inst.blurb}</span>` +
      (ch ? `<span class="badge" title="Swap color">${CHANNELS[ch].name}</span>` : '');
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('badge')) cycleChannel(inst.id);
      else toggleInstrument(inst.id, btn);
    });
    grid.appendChild(btn);
  }
}

function toggleInstrument(id, btn) {
  const hint = $('inst-hint');
  if (state.assign[id]) delete state.assign[id];
  else {
    const used = new Set(Object.values(state.assign));
    const free = CHANNEL_ORDER.find((c) => !used.has(c));
    if (!free) {
      btn.classList.add('shake');
      setTimeout(() => btn.classList.remove('shake'), 400);
      hint.textContent = 'You already have three. Tap one to free its color first.';
      return;
    }
    state.assign[id] = free;
  }
  hint.textContent = DEFAULT_HINT;
  refreshAll();
}

function cycleChannel(id) {
  const cur = state.assign[id];
  const next = CHANNEL_ORDER[(CHANNEL_ORDER.indexOf(cur) + 1) % 3];
  const other = Object.keys(state.assign).find((k) => state.assign[k] === next);
  if (other) state.assign[other] = cur;
  state.assign[id] = next;
  refreshAll();
}

function refreshAll() { renderInstruments(); renderChannels(); syncEngine(); }

// ---------- 3. Color mixer ----------
function renderChannels() {
  const wrap = $('channels');
  wrap.innerHTML = '';
  for (const ch of CHANNEL_ORDER) {
    const C = CHANNELS[ch];
    const inst = INSTRUMENT_LIST.find((i) => state.assign[i.id] === ch);
    const row = document.createElement('div');
    row.className = 'channel' + (inst ? '' : ' empty');
    row.style.setProperty('--c', C.color);
    row.innerHTML = `
      <div class="ch-head"><span class="dot"></span><span class="ch-name">${C.name} · ${C.meaning}</span>
        <span class="ch-inst">${inst ? `${inst.icon} ${inst.name}` : 'no instrument'}</span><span class="ch-val" id="val-${ch}"></span></div>
      <input type="range" id="slider-${ch}" min="0" max="100" value="${Math.round(state.levels[ch] * 100)}" aria-label="${C.name} intensity">
      <div class="ch-blurb">${C.blurb}</div>`;
    row.querySelector('input').addEventListener('input', (e) => {
      state.levels[ch] = e.target.value / 100;
      updateColor();
      syncEngine();
    });
    wrap.appendChild(row);
  }
  updateColor();
}

function updateColor() {
  const hex = levelsToHex(state.levels), mood = moodFromLevels(state.levels);
  $('swatch').style.background = hex;
  $('swatch-hex').textContent = hex.toUpperCase();
  $('color-picker').value = hex;
  $('mood-label').textContent = mood.label;
  $('mood-desc').textContent = mood.desc;
  document.documentElement.style.setProperty('--mix', hex);
  for (const ch of CHANNEL_ORDER) {
    const v = $('val-' + ch);
    if (v) v.textContent = `${Math.round(state.levels[ch] * 100)}%`;
  }
}

$('color-picker').addEventListener('input', (e) => {
  state.levels = hexToLevels(e.target.value);
  for (const ch of CHANNEL_ORDER) $('slider-' + ch).value = Math.round(state.levels[ch] * 100);
  updateColor();
  syncEngine();
});

// ---------- Transport ----------
function syncEngine() {
  const tracks = Object.entries(state.assign).map(([id, channel]) => ({ id, channel, level: state.levels[channel] }));
  engine.setConfig({ tracks, mood: moodFromLevels(state.levels), baseVol: state.baseVol, loop: state.loop });
  $('play-btn').disabled = $('export-btn').disabled = !state.buffer;
}

function updatePlayBtn() { $('play-btn').textContent = engine.playing ? '❚❚ Pause' : '▶ Play'; }
function togglePlay() {
  if (!state.buffer) return;
  if (engine.playing) engine.pause(); else engine.play(engine.pausedAt);
  updatePlayBtn();
}
engine.onEnded = updatePlayBtn;
$('play-btn').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'BUTTON'].includes(e.target.tagName)) { e.preventDefault(); togglePlay(); }
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

// ---------- init ----------
$('inst-hint').textContent = DEFAULT_HINT;
renderInstruments();
renderChannels();
syncEngine();
