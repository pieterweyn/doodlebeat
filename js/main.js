// doodlebeat: select a song → it splits into stems → set the mood → press play.
import { analyzeBuffer } from './analysis.js';
import { Engine, levelWeights } from './engine.js';
import { NEUTRAL, eqBands, EQ_DB, Q_MIN, Q_MAX } from './dsp.js';
import { padToMood, nearAnchor, moodColor, moodLabel, padToRgb, PAD_ANCHORS, INSTRUMENT_COLORS } from './mood.js';
import { MoodScope } from './moodviz.js';

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
const ICON_SOLO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16v-3.5a8 8 0 0 1 16 0V16"/><rect x="3.2" y="13.5" width="4.3" height="6.5" rx="1.6"/><rect x="16.5" y="13.5" width="4.3" height="6.5" rx="1.6"/></svg>';

const state = {
  cfg: null,
  song: null, // { id (server), name, buffer, analysis, token }
  rave: false, // RAVE textures on the channels: off by default; the per-channel model buttons only show when on
  channels: [], // { id, instrument, name, url, origUrl, origName, gainDb, muted, solo, texModel, texWet, raveOn, rave, texState, eqUser }
  pad: { x: 24 / 360, y: 0.62 }, weights: {}, amount: 1, mood: {},
  moodOn: true,
  eqDefs: [], // the 8 EQ bands (dsp.eqBands)
  mixEq: null, // combined EQ on the whole mix: your edits per band (starts flat)
  mixColor: '#b38c66',
};
const MIX = '_mix'; // scope key of the combined EQ
const engine = new Engine();
const scope = new MoodScope({ chipsEl: $('scope-chips'), eqCanvas: $('eq-canvas'), bandBarEl: $('eq-bandbar'), valuesEl: $('eq-values'), paramsEl: $('param-bars') });
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
  state.eqDefs = eqBands(cfg.schema); state.mixEq = newUserEq();
  scope.setConfig(cfg, state.eqDefs);
  $('sep-model').innerHTML = cfg.separation.models.map((m) => `<option value="${m.id}"${m.id === cfg.separation.default ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
  $('color-pad').title = `Drag to choose the mood · mood model: ${cfg.model.trained ? 'trained' : 'placeholder'}. ${cfg.model.description}`;
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
  state.song = { name: file.name, token, genre: null }; // genre: picked by you, the mood's starting point
  renderSongGenre(); setPad(state.pad.x, state.pad.y); // nothing is applied until you pick the song's genre
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

// ---- the song's own genre: you pick it first; the mood moves the mix FROM it (a Lo-fi song set to Lo-fi stays as it is) ----
function renderSongGenre() {
  const el = $('song-genre'), g = state.song?.genre;
  el.classList.toggle('need', !g);
  el.innerHTML = `<span class="sg-q">${g ? 'This song is' : 'First: what genre is this song?'}</span>` +
    state.cfg.genres.map((gn) => `<button data-genre="${gn.id}" style="--c:${gn.color}" aria-pressed="${gn.id === g}" title="${esc(gn.blurb)}">${esc(gn.name)}</button>`).join('') +
    `<span class="sg-note">${g ? `the mood starts from ${esc(state.cfg.genres.find((x) => x.id === g).name)}: only the difference is applied` : 'until you pick, the mood treats the recording as neutral'}</span>`;
  const o = $('pad-origin'), at = g && PAD_ANCHORS[g];
  o.hidden = !at;
  if (at) { // kept inside the pad; near an edge the label points inward
    o.style.left = `${Math.max(0.035, Math.min(0.965, at[0])) * 100}%`; o.style.top = `${Math.max(0.1, Math.min(0.8, at[1])) * 100}%`;
    o.dataset.edge = at[0] > 0.85 ? 'r' : at[0] < 0.15 ? 'l' : '';
  }
}
$('song-genre').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-genre]'); if (!b || !state.song) return;
  state.song.genre = state.song.genre === b.dataset.genre ? null : b.dataset.genre; // click again to clear
  renderSongGenre();
  // start exactly at the song's genre: the marker sits on its anchor, so every EQ is flat until you move away
  const at = state.song.genre && PAD_ANCHORS[state.song.genre];
  if (at) setPad(at[0], at[1]); else setPad(state.pad.x, state.pad.y);
});

function renderTrackInfo() {
  const A = state.song.analysis;
  $('lane-empty').classList.add('hidden');
  $('track-info').classList.remove('hidden');
  $('file-name').textContent = state.song.name; $('file-name').title = state.song.name;
  $('chips').innerHTML = [`${A.bpm} BPM`, A.key.name, fmt(A.duration)].map((c) => `<span class="chip">${c}</span>`).join('');
  $('t-dur').textContent = fmt(A.duration);
  $('chord-strip').innerHTML = A.chords.map((c) => `<span>${c.name}</span>`).join('');
  renderSongGenre();
  currentBar = -1;
  drawWave();
}

// ---------- song waveform ----------
const canvas = $('wave');
let waveImg = null, currentBar = -1, lastBeat = -1;
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
  const ch = { gainDb: 0, muted: false, solo: false, texModel: '', texWet: 0.5, raveOn: true, rave: null, texState: '', origUrl: info.url, origName: info.name,
    eqUser: newUserEq(), ...info };
  state.channels.push(ch);
  engine.addChannel(ch.id, buffer, { settings: effective(ch) }, restart);
}
function settingsFor(inst) { return state.mood[inst]?.settings ?? state.mood.other?.settings ?? NEUTRAL; }

// ---- EQ: 8 bands (dsp.eqBands). Your edits are kept per band; gain is an offset on top of the mood's gain. ----
const clampDb = (g) => Math.max(-EQ_DB, Math.min(EQ_DB, g));
function newUserEq() { return state.eqDefs.map(() => ({ on: null, gain: 0, freq: null, q: null, slope: null })); }
function bandsFrom(user, moodEq) {
  return state.eqDefs.map((d, i) => {
    const u = user?.[i];
    return { type: d.type, on: u?.on ?? d.on, freq: u?.freq ?? d.freq, q: u?.q ?? d.q, slope: u?.slope ?? d.slope,
      gain: clampDb((d.mood != null ? moodEq?.[d.mood] ?? 0 : 0) + (u?.gain ?? 0)) };
  });
}
const isEdited = (u) => u.some((b, i) => (b.on != null && b.on !== state.eqDefs[i].on) || Math.abs(b.gain) > 0.05 || b.freq != null || b.q != null || b.slope != null);
// What a channel actually gets: the mood's settings for its instrument, with your EQ on top.
function effective(ch) { const m = settingsFor(ch.instrument); return { ...m, bands: bandsFrom(ch.eqUser, m.eq) }; }
function applyChannel(ch) { engine.update(ch.id, { settings: effective(ch) }); }
// The combined EQ: only your hand settings (the mood shapes each channel, not the mix).
const mixBands = () => bandsFrom(state.mixEq, null);

// What a hand edit in the scope changes: the mix EQ or one channel's EQ.
function eqTarget(key) {
  if (key === MIX) return { user: state.mixEq, moodEq: null, apply: () => engine.setMixEq(mixBands()) };
  const ch = state.channels.find((c) => c.id === key); if (!ch) return null;
  return { user: ch.eqUser, moodEq: settingsFor(ch.instrument).eq, apply: () => applyChannel(ch) };
}
// patch (absolute values): { on?, gain?, freq?, q?, slope?, reset? }
scope.onEdit = (key, i, patch) => {
  const t = eqTarget(key); if (!t) return;
  const u = t.user[i], d = state.eqDefs[i];
  if (patch.reset) Object.assign(u, { gain: 0, freq: null, q: null, slope: null });
  if (patch.on != null) u.on = patch.on === d.on ? null : patch.on;
  if (patch.gain != null) u.gain = clampDb(patch.gain) - (d.mood != null ? t.moodEq?.[d.mood] ?? 0 : 0);
  if (patch.freq != null) u.freq = Math.max(20, Math.min(20000, patch.freq));
  if (patch.q != null) u.q = Math.max(Q_MIN, Math.min(Q_MAX, patch.q));
  if (patch.slope != null) u.slope = patch.slope;
  t.apply(); scope.refresh(); syncEqReset();
};
function syncEqReset() {
  const t = eqTarget(scope.sel);
  $('eq-reset').disabled = !t || !isEdited(t.user);
}
$('eq-reset').addEventListener('click', () => {
  const t = eqTarget(scope.sel); if (!t) return;
  t.user.splice(0, t.user.length, ...newUserEq());
  t.apply(); scope.refresh(); syncEqReset();
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
      <canvas data-wave title="Click to play from here"></canvas>
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
          return `<button class="rave-badge" data-act="rave" aria-pressed="${ch.raveOn}" style="--k:${COLOR_HEX[r.color]}" title="${esc(`${r.model} is ${ch.raveOn ? 'on' : 'off'}: click to switch ${ch.raveOn ? 'off' : 'on'} · ${r.color} drives it, ${fx}`)}"><b>${r.color}</b>${esc(r.model.replace(/_/g, ' '))}</button>`;
        })()}
        <input type="range" data-act="texwet" min="0" max="1" step="0.01" value="${ch.texWet}" aria-label="RAVE amount" title="RAVE amount (dry ↔ RAVE)"${ch.rave && ch.raveOn ? '' : ' disabled'}>
        <span class="tex-state" title="${esc(ch.rave ? `z${ch.rave.dim}: ${ch.rave.effect}` : '')}">${esc(ch.texState)}</span>
      </div>
      <div class="actions">
        <button class="icon-btn" data-act="replace" title="Replace with another recording">⇄</button>
        <button class="icon-btn" data-act="revert" title="Back to the original stem"${ch.url === ch.origUrl ? ' disabled' : ''}>↺</button>
        <button class="icon-btn" data-act="remove" title="Remove channel">✕</button>
      </div>
    </div>`).join('');
  syncChannelRows();
  for (const row of wrap.querySelectorAll('.channel[data-id]')) {
    const ch = state.channels.find((c) => c.id === row.dataset.id);
    drawChannelWave(ch, row.querySelector('canvas'));
  }
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
    engine.update(ch.id, { gainDb: ch.gainDb });
  } else if (act === 'texwet') {
    ch.texWet = +e.target.value;
    engine.setWet(ch.id, wetOf(ch));
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
  if (e.target.matches('canvas[data-wave]') && engine.duration) { // seek from any channel's waveform
    const r = e.target.getBoundingClientRect();
    engine.seek(clamp01((e.clientX - r.left) / r.width) * engine.duration);
    return;
  }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const ch = channelOf(btn); if (!ch) return;
  const act = btn.dataset.act;
  if (act === 'mute' || act === 'solo') {
    ch[act === 'mute' ? 'muted' : 'solo'] = !ch[act === 'mute' ? 'muted' : 'solo'];
    btn.setAttribute('aria-pressed', act === 'mute' ? ch.muted : ch.solo);
    engine.update(ch.id, { muted: ch.muted, solo: ch.solo });
    syncChannelRows();
  } else if (act === 'replace') {
    replaceTarget = ch.id; chanInput.click();
  } else if (act === 'revert') {
    swapAudio(ch, ch.origUrl, ch.origName);
  } else if (act === 'rave') { // the model label switches the RAVE model on/off (the amount knob keeps its value)
    ch.raveOn = !ch.raveOn;
    engine.setWet(ch.id, wetOf(ch));
    renderChannels();
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
  renderChannels();
  startLevels(ch);
}

// RAVE levels: the server picks the latent dim that changes this stem most and renders it at a few levels;
// the color (R, G or B) then crossfades between them live.
const wetOf = (ch) => (state.rave && ch.raveOn ? ch.texWet : 0);
// The band's RAVE button: off → no RAVE anywhere and its controls are hidden; on → the model buttons appear
// (each still switches its own channel) and the levels are rendered for channels that don't have them yet.
function syncRave() {
  $('rave-btn').setAttribute('aria-pressed', state.rave);
  document.body.classList.toggle('rave-on', state.rave);
  for (const ch of state.channels) engine.setWet(ch.id, wetOf(ch));
}
$('rave-btn').addEventListener('click', () => {
  state.rave = !state.rave; syncRave();
  if (state.rave) for (const ch of state.channels) if (!ch.rave) startLevels(ch);
});

async function startLevels(ch) {
  const r = routeFor(ch.instrument);
  const token = (ch.texToken = (ch.texToken || 0) + 1), url = ch.url;
  const show = (t) => { ch.texState = t; const el = document.querySelector(`.channel[data-id="${CSS.escape(ch.id)}"] .tex-state`); if (el) el.textContent = t; };
  if (ch.texModel !== r?.model) { ch.rave = null; engine.setLevels(ch.id, []); }
  ch.texModel = r?.model ?? '';
  if (!state.rave) { ch.rave = null; ch.texState = ''; engine.setLevels(ch.id, [], false); renderChannels(); return; } // rendered when RAVE is switched on
  if (!r || !state.song?.id) { renderChannels(); return; }
  try {
    show('…');
    let job = await (await postJSON('/api/levels', { song_id: state.song.id, src: url, model: r.model })).json();
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
    engine.setWet(ch.id, wetOf(ch));
    applyColorToLevels();
    renderChannels(); renderRgbMap();
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

function afterChannelsChanged() { refreshScopeItems(); syncTransport(); }

// ---------- ③ set the mood ----------
function setPad(x, y) {
  state.pad = { x, y };
  Object.assign(state, padToMood(x, y, state.cfg.genres));
  if (state.song && !state.song.genre) state.amount = 0; // first decide the song's genre
  placeMarker(x, y);
  applyColorToLevels();
  moodChanged();
}

function moodChanged() {
  const { cfg } = state;
  const hex = moodColor(state.weights, state.amount, cfg.genres), m = moodLabel(state.weights, state.amount, cfg.genres);
  document.documentElement.style.setProperty('--mix', hex); state.mixColor = hex;
  $('mood-label').textContent = m.label;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  $('swatch').style.color = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#111' : '#fff';
  requestMood();
}

// Ask the mood model for every instrument's settings. Requests are coalesced while one is in flight.
let moodBusy = false, moodPending = false;
async function requestMood() {
  if (moodBusy) { moodPending = true; return; }
  moodBusy = true;
  try {
    state.mood = await (await postJSON('/api/mood', { weights: state.weights, amount: state.amount, instruments: state.cfg.instruments, source: state.song?.genre ?? null })).json();
    for (const ch of state.channels) applyChannel(ch);
    scope.refresh();
   
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
  const x = clamp01((e.clientX - r.left) / r.width), y = clamp01((e.clientY - r.top) / r.height);
  const snap = nearAnchor(x, y, r.width, r.height); // close to a genre: snap onto it (exactly that genre)
  if (snap) setPad(...PAD_ANCHORS[snap]); else setPad(x, y);
}
pad.addEventListener('pointerdown', (e) => { if (!state.cfg) return; pad.setPointerCapture(e.pointerId); pickFromPad(e); });
pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) pickFromPad(e); });
// the pad changes size with the layout (e.g. when the band opens beside it): redraw it at its new size
new ResizeObserver(() => drawPad()).observe(pad);

// ---------- ④ the mood per instrument ----------
function refreshScopeItems() {
  // The combined EQ comes first and is shown by default; every channel's EQ is a thumbnail next to it.
  const mix = { key: MIX, label: 'Mix', mix: true, get color() { return state.mixColor; },
    chain: { get pre() { return engine.mixStage?.pre; }, get post() { return engine.mixStage?.post; } },
    editable: !!state.cfg, getBands: () => (state.cfg ? mixBands() : null), edited: () => isEdited(state.mixEq) };
  const items = state.channels.length
    ? state.channels.map((ch) => ({ key: ch.id, label: ch.instrument === ch.id ? ch.instrument : `${ch.instrument} · ${ch.name}`, color: colorOf(ch), instrument: ch.instrument, chain: engine.channels.get(ch.id)?.chain,
        editable: true, getBands: () => effective(ch).bands, getMoodBands: () => bandsFrom(null, settingsFor(ch.instrument).eq),
        getSettings: () => settingsFor(ch.instrument), edited: () => isEdited(ch.eqUser) }))
    // before the stems arrive: what the mood would do to each instrument (read-only)
    : (state.cfg?.instruments ?? []).map((i) => ({ key: i, label: i, color: INSTRUMENT_COLORS[i] || '#fff', instrument: i,
        getBands: () => (state.cfg ? bandsFrom(null, settingsFor(i).eq) : null), getSettings: () => settingsFor(i) }));
  scope.setItems([mix, ...items]);
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
$('mood-on').addEventListener('change', (e) => { state.moodOn = e.target.checked; engine.setBypass(!state.moodOn); });

async function exportRender(stems) {
  const btn = stems ? $('stems-btn') : $('export-btn'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Rendering…';
  try {
    const anySolo = state.channels.some((c) => c.solo);
    const body = {
      song_id: state.song.id, stems,
      mix_eq: state.moodOn ? { bands: mixBands() } : null,
      channels: state.channels.map((ch) => ({
        src: ch.url, name: ch.instrument === ch.id ? ch.instrument : `${ch.instrument}_${ch.name}`,
        settings: state.moodOn ? engine.channels.get(ch.id).settings : NEUTRAL,
        gain_db: ch.gainDb, muted: ch.muted || (anySolo && !ch.solo),
        texture_wet: ch.rave && state.moodOn ? wetOf(ch) : 0,
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
  if (orbCanvas.width !== W || orbCanvas.height !== H) { orbCanvas.width = W; orbCanvas.height = H; }
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

// The song lane pins right under the pinned logo bar, whatever height the bar wraps to.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--topbar-h', `${Math.round(e.target.getBoundingClientRect().height)}px`)).observe(document.querySelector('.topbar'));

// The logo beats along: one dot hops per beat (r, g, b, …), the word pulses on the first beat of each bar.
const brand = $('brand'), brandDots = [...brand.querySelectorAll('.d')];
function retrigger(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function beatLogo(beat, downbeat) {
  retrigger(brandDots[beat % brandDots.length], 'hit');
  if (downbeat) retrigger(brand, 'down');
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
    if (engine.playing && b !== lastBeat && A.beatTimes[b] <= pos) beatLogo(b, (b + A.barShift) % 4 === 0);
    lastBeat = engine.playing ? b : -1;
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  drawWave(); drawPad();
  document.querySelectorAll('.channel[data-id]').forEach((row) => drawChannelWave(state.channels.find((c) => c.id === row.dataset.id), row.querySelector('canvas')));
});

init();
