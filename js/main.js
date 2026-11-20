// doodlebeat: select a song → it splits into stems → set the mood → press play.
import { analyzeBuffer } from './analysis.js';
import { Engine, levelWeights } from './engine.js';
import { NEUTRAL } from './dsp.js';
import { padToMood, moodToPad, moodColor, moodLabel, padToRgb, PAD_ANCHORS, INSTRUMENT_COLORS } from './mood.js';
import { MoodScope } from './moodviz.js';
import { Visualizer, VIZ_SR } from './visualize.js';

const $ = (id) => document.getElementById(id);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixed RAVE model per channel, each driven by one component of the color: R → Isis on vocals,
// G → Musicnet on piano, B → Sol on every other channel.
const RAVE_ROUTE = {
  vocals: { model: 'isis', color: 'R' },
  piano: { model: 'musicnet', color: 'G' },
  other: { model: 'sol_ordinario_fast', color: 'B' },
};
const COLOR_HEX = { R: '#ff4d5e', G: '#3ddc84', B: '#4d8dff' };
function routeFor(inst) {
  const r = RAVE_ROUTE[inst] ?? RAVE_ROUTE.other;
  return state.cfg?.texture.models.some((m) => m.id === r.model) ? r : null;
}
const ICON_MUTE = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M3.5 3.5l17 17"/></svg>';
const ICON_SLIDERS = '<svg viewBox="0 0 24 24" aria-hidden="true" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="14" r="2.2" fill="#0b0b10"/><circle cx="12" cy="8" r="2.2" fill="#0b0b10"/><circle cx="19" cy="16" r="2.2" fill="#0b0b10"/></svg>';
const ICON_SOLO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-3.5a8 8 0 0 1 16 0V16"/><rect x="3.2" y="13.5" width="4.3" height="6.5" rx="1.6"/><rect x="16.5" y="13.5" width="4.3" height="6.5" rx="1.6"/></svg>';

const state = {
  cfg: null,
  song: null, // { id (server), name, buffer, analysis, token }
  channels: [], // { id, instrument, name, url, origUrl, origName, gainDb, muted, solo, texModel, texWet, rave, texState, eqUser, latent }
  pad: { x: 24 / 360, y: 0.62 }, weights: {}, amount: 1, mood: {},
  moodOn: true,
};
const engine = new Engine();
const viz = new Visualizer($('viz'), $('viz-status'), $('viz-toolbar'));
viz.onSeek = (f) => engine.duration && engine.seek(f * engine.duration);
const scope = new MoodScope({ chipsEl: $('scope-chips'), eqCanvas: $('eq-canvas'), paramsEl: $('param-bars'), latentCanvas: $('latent-canvas'), latentSub: $('latent-sub') });
const bufferCache = new Map(); // url → AudioBuffer
let songToken = 0, chanSeq = 0;

// ---------- server ----------
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return r;
}
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function loadAudio(url) {
  if (!bufferCache.has(url)) bufferCache.set(url, (async () => engine.context.decodeAudioData(await (await api(url)).arrayBuffer()))());
  return bufferCache.get(url);
}
function setStatus(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }

async function init() {
  try {
    state.cfg = await (await api('/api/config')).json();
  } catch {
    const b = $('server-banner');
    b.innerHTML = 'The doodlebeat server isn’t running. From the project folder run <code>.venv/bin/python doodlebeat/server/app.py</code> and open <code>http://localhost:8000</code>.';
    b.classList.remove('hidden');
    $('load-btn').disabled = true;
    return;
  }
  const cfg = state.cfg;
  engine.setSchema(cfg.schema);
  scope.setConfig(cfg);
  $('sep-model').innerHTML = cfg.separation.models.map((m) => `<option value="${m.id}"${m.id === cfg.separation.default ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  $('model-note').textContent = `Mood model: ${cfg.model.trained ? 'trained' : 'placeholder'}. ${cfg.model.description}`;
  renderGenreBars();
  renderAnchors();
  drawPad();
  setPad(state.pad.x, state.pad.y);
  refreshScopeItems();
}

// ---------- ① select a song ----------
const fileInput = $('file-input');
$('load-btn').addEventListener('click', () => fileInput.click());
$('lane-empty').addEventListener('click', () => state.cfg && fileInput.click());
$('lane').addEventListener('keydown', (e) => { if (!state.song && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) loadSong(f); fileInput.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files?.[0];
  if (f && state.cfg) loadSong(f);
});

async function loadSong(file) {
  const token = ++songToken;
  engine.stop(); updatePlayBtn();
  engine.clearChannels(); state.channels = []; bufferCache.clear();
  state.song = { name: file.name, token };
  $('band').classList.remove('hidden');
  renderChannels();
  refreshScopeItems();
  setSplit(0, 'Uploading…');
  // split on the server while the browser decodes and analyzes the original
  const upload = (async () => {
    const fd = new FormData();
    fd.append('file', file); fd.append('model', $('sep-model').value);
    return (await api('/api/songs', { method: 'POST', body: fd })).json();
  })();
  try {
    setStatus(`Decoding ${file.name}…`);
    const buf = await engine.context.decodeAudioData(await file.arrayBuffer());
    if (token !== songToken) return;
    engine.setOriginal(buf);
    const A = await analyzeBuffer(buf, (p) => setStatus(`Listening… ${Math.round(p * 100)}%`));
    if (token !== songToken) return;
    Object.assign(state.song, { buffer: buf, analysis: A });
    setStatus('');
    renderTrackInfo();
    syncTransport();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't decode “${file.name}” in the browser. The server may still split it.`, true);
  }
  try {
    const { song_id, job } = await upload;
    if (token !== songToken) return;
    state.song.id = song_id;
    await pollSplit(job.id, token);
  } catch (err) {
    if (token === songToken) setSplit(1, err.message, true);
  }
}

async function pollSplit(jobId, token) {
  for (;;) {
    const job = await (await api(`/api/jobs/${jobId}`)).json();
    if (token !== songToken) return;
    if (job.state === 'error') throw new Error(job.message);
    setSplit(job.progress, `${job.message}${job.state === 'running' ? ` ${Math.round(job.progress * 100)}%` : ''}`);
    if (job.state === 'done') {
      setSplit(1, 'Loading stems…');
      const bufs = await Promise.all(job.stems.map((s) => loadAudio(s.url)));
      if (token !== songToken) return;
      job.stems.forEach((s, i) => addChannel({ id: s.name, instrument: s.name, name: `${s.name} stem`, url: s.url }, bufs[i], false));
      engine.restartIfPlaying();
      renderChannels();
      for (const ch of state.channels) startLevels(ch);
      setSplit(1, job.message);
      setTimeout(() => token === songToken && $('split-bar').classList.add('hidden'), 2500);
      afterChannelsChanged();
      return;
    }
    await sleep(700);
  }
}

function setSplit(p, msg, err = false) {
  const bar = $('split-bar');
  bar.classList.remove('hidden'); bar.classList.toggle('err', err);
  bar.querySelector('.split-fill').style.width = `${Math.round(p * 100)}%`;
  bar.querySelector('.split-msg').textContent = msg;
}

function renderTrackInfo() {
  const A = state.song.analysis;
  $('lane-empty').classList.add('hidden');
  $('track-info').classList.remove('hidden');
  $('file-name').textContent = state.song.name; $('file-name').title = state.song.name;
  $('chips').innerHTML = [`${A.bpm} BPM`, A.key.name, fmt(A.duration)].map((c) => `<span class="chip">${c}</span>`).join('');
  $('t-dur').textContent = fmt(A.duration);
  $('chord-strip').innerHTML = A.chords.map((c) => `<span>${c.name}</span>`).join('');
  currentBar = -1;
  drawWave();
}

// ---------- song waveform ----------
const canvas = $('wave');
let waveImg = null, currentBar = -1;
function drawWave() {
  const buf = state.song?.buffer; if (!buf) return;
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  canvas.width = w; canvas.height = h;
  const off = document.createElement('canvas'); off.width = w; off.height = h;
  const g = off.getContext('2d'), data = buf.getChannelData(0), A = state.song.analysis, spp = data.length / w;
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
  if (!engine.duration) return;
  const r = canvas.getBoundingClientRect();
  engine.seek(((e.clientX - r.left) / r.width) * engine.duration);
});

// ---------- ② the band ----------
const colorOf = (ch) => INSTRUMENT_COLORS[ch.instrument] || INSTRUMENT_COLORS.other;
function guessInstrument(name) {
  const n = name.toLowerCase();
  if (/voc|vox|voice|sing|lead/.test(n)) return 'vocals';
  if (/drum|kick|snare|hat|beat|perc/.test(n)) return 'drums';
  if (/bass|808|sub/.test(n)) return 'bass';
  if (/guitar|gtr/.test(n)) return 'guitar';
  if (/piano|keys|rhodes/.test(n)) return 'piano';
  return 'other';
}

function addChannel(info, buffer, restart = true) {
  const ch = { gainDb: 0, muted: false, solo: false, texModel: '', texWet: 0.5, rave: null, texState: '', origUrl: info.url, origName: info.name,
    eqUser: { gain: [0, 0, 0, 0, 0], freq: [null, null, null, null, null] }, ...info };
  state.channels.push(ch);
  engine.addChannel(ch.id, buffer, { settings: effective(ch) }, restart);
}
function settingsFor(inst) { return state.mood[inst]?.settings ?? state.mood.other?.settings ?? NEUTRAL; }

// What a channel actually gets: the mood's settings for its instrument + your hand EQ on top.
function effective(ch) {
  const m = settingsFor(ch.instrument), bands = state.cfg.schema.bands;
  return { ...m, eq: m.eq.map((g, i) => Math.max(-15, Math.min(15, g + ch.eqUser.gain[i]))), freqs: bands.map((b, i) => ch.eqUser.freq[i] ?? b.freq) };
}
const isEdited = (ch) => ch.eqUser.gain.some((g) => Math.abs(g) > 0.05) || ch.eqUser.freq.some((f) => f != null);
function applyChannel(ch) { engine.update(ch.id, { settings: effective(ch) }); }

scope.onEdit = (key, i, { gain, freq, reset }) => {
  const ch = state.channels.find((c) => c.id === key); if (!ch) return;
  if (reset) { ch.eqUser.gain[i] = 0; ch.eqUser.freq[i] = null; }
  else {
    const base = state.cfg.schema.bands[i].freq;
    ch.eqUser.gain[i] = gain - settingsFor(ch.instrument).eq[i];
    ch.eqUser.freq[i] = Math.max(Math.max(20, base / 4), Math.min(Math.min(20000, base * 4), freq)); // each band moves within 2 octaves
  }
  applyChannel(ch); scope.renderParams(); syncEqReset(); scheduleViz();
};
function syncEqReset() {
  const ch = state.channels.find((c) => c.id === scope.sel);
  $('eq-reset').disabled = !ch || !isEdited(ch);
}
$('eq-reset').addEventListener('click', () => {
  const ch = state.channels.find((c) => c.id === scope.sel); if (!ch) return;
  ch.eqUser = { gain: [0, 0, 0, 0, 0], freq: [null, null, null, null, null] };
  applyChannel(ch); scope.renderParams(); syncEqReset(); scheduleViz();
});
$('scope-chips').addEventListener('click', () => setTimeout(syncEqReset));

function renderChannels() {
  const wrap = $('channels');
  if (!state.channels.length) {
    wrap.innerHTML = state.song ? Array.from({ length: 4 }, () => '<div class="channel skeleton"><span class="tint" style="background:#2a2a34"></span><div class="shimmer"></div></div>').join('') : '';
    $('add-channel').disabled = true;
    return;
  }
  $('add-channel').disabled = !state.song?.id;
  const tex = state.cfg.texture;
  wrap.innerHTML = state.channels.map((ch) => `
    <div class="channel" data-id="${ch.id}" style="--c:${colorOf(ch)}">
      <span class="tint"></span>
      <div class="who">
        <select data-act="inst" aria-label="Instrument of this channel (sets which mood profile it gets)">
          ${state.cfg.instruments.map((i) => `<option value="${i}"${i === ch.instrument ? ' selected' : ''}>${i}</option>`).join('')}
        </select>
        <span class="name" title="${esc(ch.name)}">${esc(ch.name)}</span>
      </div>
      <canvas data-wave aria-hidden="true"></canvas>
      <div class="ms">
        <button class="m" data-act="mute" aria-pressed="${ch.muted}" title="Mute" aria-label="Mute">${ICON_MUTE}</button>
        <button class="s" data-act="solo" aria-pressed="${ch.solo}" title="Solo (listen to this channel alone)" aria-label="Solo">${ICON_SOLO}</button>
      </div>
      <label class="gain">
        <input type="range" data-act="gain" min="-24" max="6" step="0.5" value="${ch.gainDb}" aria-label="Channel level">
        <span>${ch.gainDb > 0 ? '+' : ''}${ch.gainDb.toFixed(1)}</span>
      </label>
      <div class="tex">
        ${(() => {
          const r = routeFor(ch.instrument);
          if (!r) return '<span class="rave-badge off" title="RAVE model not found in models/rave">RAVE: –</span>';
          const fx = ch.rave ? `z${ch.rave.dim}: ${ch.rave.effect}` : 'preparing…';
          return `<span class="rave-badge" style="--k:${COLOR_HEX[r.color]}" title="${esc(`${r.color} drives ${r.model}, ${fx}`)}"><b>${r.color}</b>${esc(r.model.replace(/_/g, ' '))}</span>`;
        })()}
        <input type="range" data-act="texwet" min="0" max="1" step="0.01" value="${ch.texWet}" aria-label="RAVE amount" title="RAVE amount (dry ↔ RAVE)"${ch.rave ? '' : ' disabled'}>
        <span class="tex-state" title="${esc(ch.rave ? `z${ch.rave.dim}: ${ch.rave.effect}` : '')}">${esc(ch.texState)}</span>
        <button class="icon-btn lat-btn" data-act="latent" aria-pressed="${!!ch.latentOpen}" title="Latent dimensions of this model"${ch.texModel ? '' : ' disabled'}>${ICON_SLIDERS}</button>
      </div>
      <div class="actions">
        <button class="icon-btn" data-act="replace" title="Replace with another recording">⇄</button>
        <button class="icon-btn" data-act="revert" title="Back to the original stem"${ch.url === ch.origUrl ? ' disabled' : ''}>↺</button>
        <button class="icon-btn" data-act="remove" title="Remove channel">✕</button>
      </div>
      ${ch.latentOpen && ch.texModel ? latentPanel(ch) : ''}
    </div>`).join('');
  syncChannelRows();
  for (const row of wrap.querySelectorAll('.channel[data-id]')) {
    const ch = state.channels.find((c) => c.id === row.dataset.id);
    drawChannelWave(ch, row.querySelector('canvas'));
  }
}

// ---- RAVE latent: one shift + one scale per latent dimension (z = z · scale + shift, as in the RAVE docs) ----
const modelInfo = (id) => state.cfg.texture.models.find((m) => m.id === id);
function ensureLatent(ch) {
  const m = modelInfo(ch.texModel), n = m?.latent_size || 0;
  if (ch.latent?.model !== ch.texModel || ch.latent.bias.length !== n) {
    ch.latent = { model: ch.texModel, bias: Array(n).fill(0), scale: Array(n).fill(1), dirty: false };
  }
  return ch.latent;
}
const isLatentEdited = (L) => L && (L.bias.some((b) => Math.abs(b) > 1e-6) || L.scale.some((x) => Math.abs(x - 1) > 1e-6));
function latentPanel(ch) {
  const m = modelInfo(ch.texModel), L = ensureLatent(ch), maxShare = Math.max(...(m.latent_share || [1]));
  const dims = L.bias.map((b, i) => {
    const share = m.latent_share?.[i], driven = ch.rave?.dim === i, r = routeFor(ch.instrument);
    if (driven) {
      return `<div class="lp-dim driven" style="--k:${COLOR_HEX[r.color]}">
      <div class="lp-top"><b>z${i}</b>${share != null ? `<span class="lp-share"><i style="width:${(share / maxShare) * 100}%"></i></span><em>${Math.round(share * 100)}%</em>` : ''}</div>
      <div class="lp-driven">driven by <b>${r.color}</b><br>${esc(ch.rave.effect)}<br><span>latent shift ±${Math.abs(ch.rave.shifts[0])}</span></div>
    </div>`;
    }
    return `<div class="lp-dim">
      <div class="lp-top"><b>z${i}</b>${share != null ? `<span class="lp-share" title="share of the sound this dimension carries"><i style="width:${(share / maxShare) * 100}%"></i></span><em>${Math.round(share * 100)}%</em>` : ''}</div>
      <label>shift <input type="range" data-act="lat-bias" data-i="${i}" min="-3" max="3" step="0.05" value="${b}"><output>${b >= 0 ? '+' : ''}${b.toFixed(2)}</output></label>
      <label>scale <input type="range" data-act="lat-scale" data-i="${i}" min="0" max="3" step="0.05" value="${L.scale[i]}"><output>×${L.scale[i].toFixed(2)}</output></label>
    </div>`;
  }).join('');
  return `<div class="latent-panel">
    <div class="lp-head">
      <div><b>${esc(m.name)}</b> · ${L.bias.length} latent dimensions<br>
        <span class="hint">The color moves the highlighted dimension live. The others are yours: <b>shift</b> moves the sound along a dimension; <b>scale</b> below 1 makes it more generic, above 1 exaggerates it. Then press Render.</span></div>
      <div class="lp-actions">
        <button class="pill ghost small" data-act="lat-random" title="Random shifts on the strongest dimensions">Random</button>
        <button class="pill ghost small" data-act="lat-reset">Reset</button>
        <button class="pill small lat-apply${L.dirty ? ' dirty' : ''}" data-act="lat-apply">Render ▸</button>
      </div>
    </div>
    <div class="lp-grid">${dims}</div>
  </div>`;
}

function syncChannelRows() {
  const anySolo = state.channels.some((c) => c.solo);
  for (const ch of state.channels) {
    const row = document.querySelector(`.channel[data-id="${CSS.escape(ch.id)}"]`);
    row?.classList.toggle('muted-out', ch.muted || (anySolo && !ch.solo));
  }
}

const waveCache = new Map(); // channel id → { url, img }
function drawChannelWave(ch, cv) {
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1, W = Math.max(1, cv.clientWidth * dpr), H = Math.max(1, cv.clientHeight * dpr);
  cv.width = W; cv.height = H;
  let c = waveCache.get(ch.id);
  if (!c || c.url !== ch.url || c.img.width !== W) {
    const buf = engine.channels.get(ch.id)?.buffer; if (!buf) return;
    const off = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = off.getContext('2d');
    const d = buf.getChannelData(0), spp = d.length / W;
    let peak = 1e-6;
    for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]));
    g.fillStyle = colorOf(ch);
    for (let x = 0; x < W; x++) {
      let m = 0; const a = Math.floor(x * spp), b = Math.min(d.length, Math.floor((x + 1) * spp));
      for (let i = a; i < b; i += 16) m = Math.max(m, Math.abs(d[i]));
      const hh = Math.max(1, (m / peak) * H * 0.9);
      g.fillRect(x, (H - hh) / 2, 1, hh);
    }
    c = { url: ch.url, img: off, color: colorOf(ch) };
    waveCache.set(ch.id, c);
  }
  cv._wave = c;
}

const channelOf = (el) => state.channels.find((c) => c.id === el.closest('.channel')?.dataset.id);
$('channels').addEventListener('input', (e) => {
  const ch = channelOf(e.target); if (!ch) return;
  const act = e.target.dataset.act;
  if (act === 'gain') {
    ch.gainDb = +e.target.value;
    e.target.nextElementSibling.textContent = `${ch.gainDb > 0 ? '+' : ''}${ch.gainDb.toFixed(1)}`;
    engine.update(ch.id, { gainDb: ch.gainDb }); scheduleViz();
  } else if (act === 'texwet') {
    ch.texWet = +e.target.value;
    engine.setWet(ch.id, ch.texWet); scheduleViz();
  } else if (act === 'lat-bias' || act === 'lat-scale') {
    const L = ensureLatent(ch), i = +e.target.dataset.i, v = +e.target.value;
    if (act === 'lat-bias') { L.bias[i] = v; e.target.nextElementSibling.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; }
    else { L.scale[i] = v; e.target.nextElementSibling.textContent = `×${v.toFixed(2)}`; }
    L.dirty = true;
    e.target.closest('.channel').querySelector('.lat-apply')?.classList.add('dirty');
  }
});
$('channels').addEventListener('change', (e) => {
  const ch = channelOf(e.target); if (!ch) return;
  const act = e.target.dataset.act;
  if (act === 'inst') {
    ch.instrument = e.target.value;
    waveCache.delete(ch.id);
    applyChannel(ch);
    renderChannels(); afterChannelsChanged();
    if (routeFor(ch.instrument)?.model !== ch.texModel) startLevels(ch);
  }
});
let replaceTarget = null;
const chanInput = $('channel-input');
$('channels').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const ch = channelOf(btn); if (!ch) return;
  const act = btn.dataset.act;
  if (act === 'mute' || act === 'solo') {
    ch[act === 'mute' ? 'muted' : 'solo'] = !ch[act === 'mute' ? 'muted' : 'solo'];
    btn.setAttribute('aria-pressed', act === 'mute' ? ch.muted : ch.solo);
    engine.update(ch.id, { muted: ch.muted, solo: ch.solo });
    syncChannelRows(); scheduleViz();
  } else if (act === 'replace') {
    replaceTarget = ch.id; chanInput.click();
  } else if (act === 'revert') {
    swapAudio(ch, ch.origUrl, ch.origName);
  } else if (act === 'latent') {
    ch.latentOpen = !ch.latentOpen; renderChannels();
  } else if (act === 'lat-apply') {
    startLevels(ch);
  } else if (act === 'lat-reset') {
    const L = ensureLatent(ch);
    L.bias.fill(0); L.scale.fill(1); L.dirty = true; renderChannels();
  } else if (act === 'lat-random') {
    const L = ensureLatent(ch);
    L.bias = L.bias.map((_, i) => (i < 4 && i !== ch.rave?.dim ? Math.round((Math.random() * 3 - 1.5) * 20) / 20 : 0)); L.dirty = true; renderChannels();
  } else if (act === 'remove') {
    engine.removeChannel(ch.id);
    state.channels = state.channels.filter((c) => c !== ch);
    renderChannels(); afterChannelsChanged();
  }
});
$('add-channel').addEventListener('click', () => { replaceTarget = null; chanInput.click(); });
chanInput.addEventListener('change', async () => {
  const f = chanInput.files[0]; chanInput.value = '';
  if (!f || !state.song?.id) return;
  const target = replaceTarget, token = songToken;
  setStatus(`Uploading ${f.name}…`);
  try {
    const fd = new FormData(); fd.append('file', f);
    const info = await (await api(`/api/songs/${state.song.id}/channels`, { method: 'POST', body: fd })).json();
    if (token !== songToken) return;
    const ch = state.channels.find((c) => c.id === target);
    if (ch) await swapAudio(ch, info.url, info.name);
    else {
      const buf = await loadAudio(info.url);
      addChannel({ id: `c${++chanSeq}`, instrument: guessInstrument(info.name), name: info.name, url: info.url }, buf);
      renderChannels(); afterChannelsChanged();
      startLevels(state.channels.at(-1));
    }
    setStatus('');
  } catch (err) { setStatus(err.message, true); }
});

async function swapAudio(ch, url, name) {
  const buf = await loadAudio(url);
  Object.assign(ch, { url, name });
  engine.setBuffer(ch.id, buf);
  renderChannels(); scheduleViz();
  startLevels(ch);
}

// RAVE levels: the server picks the latent dim that changes this stem most and renders it at a few levels;
// the color (R, G or B) then crossfades between them live.
async function startLevels(ch) {
  const r = routeFor(ch.instrument);
  const token = (ch.texToken = (ch.texToken || 0) + 1), url = ch.url;
  const show = (t) => { ch.texState = t; const el = document.querySelector(`.channel[data-id="${CSS.escape(ch.id)}"] .tex-state`); if (el) el.textContent = t; };
  if (ch.texModel !== r?.model) { ch.rave = null; engine.setLevels(ch.id, []); }
  ch.texModel = r?.model ?? '';
  if (!r || !state.song?.id) { renderChannels(); return; }
  const L = ensureLatent(ch);
  const latent = isLatentEdited(L) ? { bias: [...L.bias], scale: [...L.scale] } : {};
  L.dirty = false;
  document.querySelector(`.channel[data-id="${CSS.escape(ch.id)}"] .lat-apply`)?.classList.remove('dirty');
  try {
    show('…');
    let job = await (await postJSON('/api/levels', { song_id: state.song.id, src: url, model: r.model, ...latent })).json();
    while (job.state !== 'done') {
      if (job.state === 'error') throw new Error(job.message);
      show(job.state === 'queued' ? 'queued' : `${Math.round(job.progress * 100)}%`);
      await sleep(800);
      if (ch.texToken !== token || ch.url !== url) return; // changed meanwhile
      job = await (await api(`/api/texture/jobs/${job.id}`)).json();
    }
    const bufs = await Promise.all(job.result.levels.map(loadAudio));
    if (ch.texToken !== token || ch.url !== url) return;
    ch.rave = job.result; ch.texState = '✓';
    engine.setLevels(ch.id, bufs);
    applyColorToLevels();
    renderChannels(); renderRgbMap(); scheduleViz();
  } catch (err) {
    ch.texState = '!'; renderChannels(); setStatus(err.message, true);
  }
}

// R, G, B of the pad color (0…1) → position between each channel's RAVE levels
function colorRGB() { return padToRgb(state.pad.x, state.pad.y); }
function applyColorToLevels() {
  const rgb = colorRGB();
  for (const ch of state.channels) {
    const r = routeFor(ch.instrument), e = engine.channels.get(ch.id);
    if (!r || !e?.levels.length) continue;
    engine.setLevelPos(ch.id, rgb['RGB'.indexOf(r.color)] * (e.levels.length - 1));
  }
  renderRgbMap();
}
function renderRgbMap() {
  const el = $('rgb-map'); if (!el || !state.cfg) return;
  const rgb = colorRGB();
  el.innerHTML = ['R', 'G', 'B'].map((c, i) => {
    const chans = state.channels.filter((ch) => routeFor(ch.instrument)?.color === c);
    const model = Object.values(RAVE_ROUTE).find((r) => r.color === c).model.replace(/_/g, ' ');
    const who = chans.length ? chans.map((ch) => ch.instrument).join(', ') : c === 'R' ? 'vocals' : c === 'G' ? 'piano' : 'others';
    const fx = chans.find((ch) => ch.rave)?.rave;
    const words = fx ? fx.effect.split(' ↔ ') : null;
    return `<div class="rgb-row" style="--k:${COLOR_HEX[c]}" title="${esc(fx ? chans.filter((ch) => ch.rave).map((ch) => `${ch.instrument}: z${ch.rave.dim} ${ch.rave.effect}`).join(' · ') : '')}">
      <b>${c}</b><span class="rgb-track"><i style="width:${Math.round(rgb[i] * 100)}%"></i></span><em>${Math.round(rgb[i] * 100)}%</em>
      <span class="rgb-who">${esc(model)} → ${esc(who)}${words ? ` · <span class="rgb-fx">${esc(words[rgb[i] < 0.5 ? 0 : 1])}</span>` : ''}</span></div>`;
  }).join('');
}

function afterChannelsChanged() { refreshScopeItems(); syncTransport(); scheduleViz(); }

// ---------- ③ set the mood ----------
function renderGenreBars() {
  $('genre-bars').innerHTML = state.cfg.genres.map((g) => `
    <div class="grow" style="--c:${g.color}" title="${esc(g.blurb)}">
      <span class="gname">${esc(g.name)}</span>
      <div class="gbar" data-genre="${g.id}" role="slider" tabindex="0" aria-label="${esc(g.name)} share" aria-valuemin="0" aria-valuemax="100" style="--c:${g.color}"><div class="gfill"></div></div>
      <b data-pct="${g.id}">0%</b>
    </div>`).join('');
  for (const bar of document.querySelectorAll('.gbar[data-genre]')) bindBar(bar, (v) => setGenreWeight(bar.dataset.genre, v), () => state.weights[bar.dataset.genre] || 0);
  bindBar($('strength-bar'), (v) => { state.amount = v; moodChanged(); }, () => state.amount);
}

function bindBar(el, set, get) {
  const fromX = (x) => { const r = el.getBoundingClientRect(); set(clamp01((x - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); fromX(e.clientX); });
  el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) fromX(e.clientX); });
  el.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 0.02, ArrowUp: 0.02, ArrowLeft: -0.02, ArrowDown: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step === undefined) return;
    e.preventDefault(); set(clamp01(get() + step));
  });
}

// Editing one genre rescales the others so the blend still sums to 100%.
function setGenreWeight(id, v) {
  const others = state.cfg.genres.map((g) => g.id).filter((g) => g !== id);
  const rest = others.reduce((s, g) => s + (state.weights[g] || 0), 0);
  const w = { [id]: v };
  for (const g of others) w[g] = rest > 1e-6 ? ((state.weights[g] || 0) / rest) * (1 - v) : (1 - v) / others.length;
  state.weights = w;
  const [x] = moodToPad(w);
  state.pad.x = x;
  placeMarker(state.pad.x, state.pad.y);
  moodChanged();
}

function setPad(x, y) {
  state.pad = { x, y };
  Object.assign(state, padToMood(x, y, state.cfg.genres));
  placeMarker(x, y);
  applyColorToLevels();
  moodChanged();
}

function moodChanged() {
  const { cfg } = state;
  const hex = moodColor(state.weights, state.amount, cfg.genres), m = moodLabel(state.weights, state.amount, cfg.genres);
  document.documentElement.style.setProperty('--mix', hex);
  $('mood-label').textContent = m.label; $('mood-desc').textContent = m.desc;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  $('swatch').style.color = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111' : '#fff';
  for (const gn of cfg.genres) {
    const w = state.weights[gn.id] || 0, bar = document.querySelector(`.gbar[data-genre="${gn.id}"]`);
    bar.style.setProperty('--v', w); bar.setAttribute('aria-valuenow', Math.round(w * 100));
    document.querySelector(`[data-pct="${gn.id}"]`).textContent = `${Math.round(w * 100)}%`;
  }
  $('strength-bar').style.setProperty('--v', state.amount);
  $('strength-bar').setAttribute('aria-valuenow', Math.round(state.amount * 100));
  $('strength-val').textContent = `${Math.round(state.amount * 100)}%`;
  requestMood();
}

// Ask the mood model for every instrument's settings. Requests are coalesced while one is in flight.
let moodBusy = false, moodPending = false;
async function requestMood() {
  if (moodBusy) { moodPending = true; return; }
  moodBusy = true;
  try {
    state.mood = await (await postJSON('/api/mood', { weights: state.weights, amount: state.amount, instruments: state.cfg.instruments })).json();
    for (const ch of state.channels) applyChannel(ch);
    scope.setMood(state.mood, state.weights);
    scheduleViz();
  } catch (err) { setStatus(`Mood model: ${err.message}`, true); }
  moodBusy = false;
  if (moodPending) { moodPending = false; requestMood(); }
}

// Color pad: x = hue, y = white (top) → pure (middle) → black (bottom)
const pad = $('color-pad'), marker = $('pad-marker');
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
function renderAnchors() {
  $('pad-anchors').innerHTML = state.cfg.genres.map((g) => {
    const [x, y] = PAD_ANCHORS[g.id] ?? [0.5, 0.5];
    const shift = x > 0.92 ? '-100%' : x < 0.08 ? '0%' : '-50%'; // keep edge labels inside the pad
    return `<span style="left:${x * 100}%;top:${y * 100}%;transform:translate(${shift},-50%)">${esc(g.name)}</span>`;
  }).join('');
}
function placeMarker(x, y) { marker.style.left = `${x * 100}%`; marker.style.top = `${y * 100}%`; }
function pickFromPad(e) {
  const r = pad.getBoundingClientRect();
  setPad(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
}
pad.addEventListener('pointerdown', (e) => { if (!state.cfg) return; pad.setPointerCapture(e.pointerId); pickFromPad(e); });
pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) pickFromPad(e); });

// ---------- spectrum overlay ----------
const overlay = $('spectrum-overlay'), specBtn = $('spectrum-btn');
function openSpectrum(open) {
  if (open === !overlay.hidden) return;
  specBtn.setAttribute('aria-expanded', open);
  if (open) {
    overlay.hidden = false; overlay.classList.remove('closing');
    viz.redraw(); scheduleViz(0);
  } else {
    overlay.classList.add('closing');
    overlay.addEventListener('animationend', () => { overlay.hidden = true; overlay.classList.remove('closing'); }, { once: true });
  }
}
specBtn.addEventListener('click', () => openSpectrum(overlay.hidden));
$('spectrum-close').addEventListener('click', () => openSpectrum(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) openSpectrum(false); });

const vizCache = new Map(); // key → Float32Array
let vizTimer = null, vizVer = 0;
async function cached(key, fn) { if (!vizCache.has(key)) vizCache.set(key, await fn()); return vizCache.get(key); }
function scheduleViz(delay = 500) {
  if (overlay.hidden || !state.song?.buffer) return;
  clearTimeout(vizTimer);
  $('viz-status').textContent = 'Updating…';
  vizTimer = setTimeout(async () => {
    const ver = ++vizVer;
    try {
      const original = await cached(`orig|${state.song.token}`, () => engine.renderBuffer(state.song.buffer, VIZ_SR));
      const anySolo = state.channels.some((c) => c.solo), layers = [];
      for (const ch of state.channels) {
        if (ch.muted || (anySolo && !ch.solo)) continue;
        const e = engine.channels.get(ch.id), s = state.moodOn ? e.settings : NEUTRAL;
        $('viz-status').textContent = `Rendering ${ch.instrument}…`;
        const key = JSON.stringify([ch.url, ch.rave?.levels, e.levels.length && state.moodOn ? [ch.texWet, e.levelPos.toFixed(2)] : 0, ch.gainDb, s]);
        const x = await cached(key, () => engine.renderChannel(ch.id, VIZ_SR, { bypass: !state.moodOn }));
        const dry = await cached(`dry|${ch.url}`, () => engine.renderBuffer(e.buffer, VIZ_SR));
        layers.push({ key: ch.id, title: `${ch.instrument} · ${ch.name}`, sub: state.moodOn ? `with the mood${ch.rave && ch.texWet ? ` + RAVE ${ch.texModel} (z${ch.rave.dim}, ${routeFor(ch.instrument).color})` : ''}` : 'mood off', color: colorOf(ch), x, dry });
      }
      if (ver !== vizVer) return;
      if (vizCache.size > 80) vizCache.clear();
      await viz.show({ name: state.song.name, moodColor: getComputedStyle(document.documentElement).getPropertyValue('--mix').trim(), original, layers }, true);
    } catch (err) { console.error(err); $('viz-status').textContent = 'Visualization failed (see console).'; }
  }, delay);
}

// ---------- ④ the mood per instrument ----------
function refreshScopeItems() {
  const items = state.channels.length
    ? state.channels.map((ch) => ({ key: ch.id, label: ch.instrument === ch.id ? ch.instrument : `${ch.instrument} · ${ch.name}`, color: colorOf(ch), instrument: ch.instrument, chain: engine.channels.get(ch.id)?.chain,
        editable: true, getSettings: () => effective(ch), getMoodSettings: () => settingsFor(ch.instrument), edited: () => isEdited(ch) }))
    : (state.cfg?.instruments ?? []).map((i) => ({ key: i, label: i, color: INSTRUMENT_COLORS[i] || '#fff', instrument: i }));
  scope.setItems(items);
  syncEqReset();
}

// ---------- transport ----------
function syncTransport() {
  const ready = !!engine.duration;
  $('play-btn').disabled = !ready;
  const stems = state.channels.length > 0 && !!state.song?.id;
  $('export-btn').disabled = $('stems-btn').disabled = !stems;
  $('mode-tag').textContent = !ready ? '' : stems ? `${state.channels.length} channels` : 'original (stems on the way)';
  $('t-dur').textContent = fmt(engine.duration);
}
function updatePlayBtn() {
  const btn = $('play-btn');
  btn.textContent = engine.playing ? '❚❚' : '▶';
  btn.setAttribute('aria-label', engine.playing ? 'Pause' : 'Play');
}
function togglePlay() {
  if (!engine.duration) return;
  if (engine.playing) engine.pause(); else engine.play(engine.pausedAt);
  updatePlayBtn();
}
engine.onEnded = updatePlayBtn;
$('play-btn').addEventListener('click', togglePlay);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'BUTTON', 'SELECT'].includes(e.target.tagName) && !e.target.closest('[role="slider"]')) { e.preventDefault(); togglePlay(); }
});
$('loop').addEventListener('change', (e) => engine.setLoop(e.target.checked));
$('mood-on').addEventListener('change', (e) => { state.moodOn = e.target.checked; engine.setBypass(!state.moodOn); scheduleViz(); });

async function exportRender(stems) {
  const btn = stems ? $('stems-btn') : $('export-btn'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const anySolo = state.channels.some((c) => c.solo);
    const body = {
      song_id: state.song.id, stems,
      channels: state.channels.map((ch) => ({
        src: ch.url, name: ch.instrument === ch.id ? ch.instrument : `${ch.instrument}_${ch.name}`,
        settings: state.moodOn ? engine.channels.get(ch.id).settings : NEUTRAL,
        gain_db: ch.gainDb, muted: ch.muted || (anySolo && !ch.solo),
        texture_wet: ch.rave && state.moodOn ? ch.texWet : 0,
        levels: ch.rave ? ch.rave.levels.map((u, i) => [u, levelWeights(ch.rave.levels.length, engine.channels.get(ch.id).levelPos)[i]]) : null,
      })),
    };
    const blob = await (await postJSON('/api/render', body)).blob();
    const base = state.song.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
    const mood = state.moodOn ? $('mood-label').textContent.replace(/[^\w-]+/g, '_') : 'original';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${base}-${mood}${stems ? '-stems.zip' : '.wav'}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) { setStatus(`Render failed: ${err.message}`, true); }
  btn.disabled = false; btn.textContent = label;
}
$('export-btn').addEventListener('click', () => exportRender(false));
$('stems-btn').addEventListener('click', () => exportRender(true));

// ---------- per-frame visuals ----------
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
  const target = Math.min(1, rms * 3.2);
  orbLevel += (target - orbLevel) * (target > orbLevel ? 0.55 : 0.12);
  orbWrap.style.setProperty('--level', orbLevel.toFixed(3));
  const dpr = window.devicePixelRatio || 1, W = orbCanvas.clientWidth * dpr, H = orbCanvas.clientHeight * dpr;
  if (orbCanvas.width !== W) { orbCanvas.width = W; orbCanvas.height = H; }
  const g = orbCanvas.getContext('2d');
  g.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, orbR = ($('swatch').clientWidth / 2) * (1 + orbLevel * 0.05) * dpr;
  const r0 = orbR + 14 * dpr, amp = 12 * dpr, n = 128, color = getComputedStyle(document.documentElement).getPropertyValue('--mix').trim();
  g.lineWidth = 1.5 * dpr; g.strokeStyle = color; g.shadowColor = color; g.shadowBlur = 8 * dpr; g.globalAlpha = playing ? 0.55 : 0.2;
  g.beginPath();
  const win = playing ? Math.floor(scopeBuf.length / n) : 1;
  for (let i = 0; i <= n; i++) {
    const k = i % n, ang = (k / n) * Math.PI * 2 - Math.PI / 2;
    let s = 0;
    if (playing) { const j0 = k * win; for (let j = 0; j < win; j++) s += scopeBuf[j0 + j]; s /= win; }
    const r = r0 + Math.max(-1, Math.min(1, s * 2)) * amp;
    const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke(); g.globalAlpha = 1; g.shadowBlur = 0;
}

function frame() {
  drawOrb();
  const dur = engine.duration, pos = engine.position, frac = dur ? pos / dur : 0;
  const mix = getComputedStyle(document.documentElement).getPropertyValue('--mix').trim();
  if (waveImg && state.song?.analysis) {
    const g = canvas.getContext('2d'), x = frac * canvas.width, A = state.song.analysis;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(waveImg, 0, 0);
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = mix; g.fillRect(0, 0, x, canvas.height);
    g.globalCompositeOperation = 'source-over'; g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), canvas.height);
    let b = 0;
    while (b < A.beatTimes.length - 1 && A.beatTimes[b + 1] <= pos) b++;
    const bar = engine.playing ? Math.min(A.chords.length - 1, Math.floor((b + A.barShift) / 4)) : -1;
    if (bar !== currentBar) {
      const spans = $('chord-strip').children;
      spans[currentBar]?.classList.remove('now'); spans[bar]?.classList.add('now');
      currentBar = bar;
    }
  }
  for (const cv of document.querySelectorAll('.channel canvas[data-wave]')) {
    const c = cv._wave; if (!c) continue;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height); g.globalAlpha = 0.45; g.drawImage(c.img, 0, 0);
    g.globalAlpha = 1; g.drawImage(c.img, 0, 0, frac * cv.width, cv.height, 0, 0, frac * cv.width, cv.height);
    g.fillStyle = '#fff'; g.fillRect(frac * cv.width, 0, 1.5, cv.height);
  }
  $('t-cur').textContent = fmt(pos);
  scope.frame(engine.playing);
  if (!overlay.hidden) viz.drawPlayhead(frac);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  drawWave(); drawPad(); viz.redraw();
  document.querySelectorAll('.channel[data-id]').forEach((row) => drawChannelWave(state.channels.find((c) => c.id === row.dataset.id), row.querySelector('canvas')));
});

init();
