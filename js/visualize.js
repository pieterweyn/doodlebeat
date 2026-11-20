// Spectral view: Original → each channel with its mood → the mood mix, each with a labelled waveform +
// log-frequency spectrogram, plus a consolidated spectrogram colored by channel.
// All rows share one zoomable/pannable time view; zooming recomputes a sharp spectrogram for the window.
import { fft } from './analysis.js';

export const VIZ_SR = 22050;
const SR = VIZ_SR, N = 2048, FMIN = 30, FMAX = 11000, DB_RANGE = 80;
const COLS = 900, ROWS = 160;
const ROW_H = 176, WAVE_H = 40, SPEC_Y = 50, GUTTER = 36;
const MIN_SPAN_SEC = 0.25;
const INFERNO = [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]];
const INPUT_COLOR = '#9aa0ae';

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
const signed = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);
const fmtS = (t, step = 1) => t.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);

// --- STFT on a log-frequency grid -------------------------------------------------
const win = new Float32Array(N), cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = Math.sin((2 * Math.PI * i) / N); }
const rowLo = new Int32Array(ROWS), rowHi = new Int32Array(ROWS), rowFreq = new Float32Array(ROWS);
for (let r = 0; r < ROWS; r++) {
  const f0 = FMIN * (FMAX / FMIN) ** (r / ROWS), f1 = FMIN * (FMAX / FMIN) ** ((r + 1) / ROWS);
  rowLo[r] = Math.max(1, Math.floor((f0 * N) / SR));
  rowHi[r] = Math.max(rowLo[r], Math.ceil((f1 * N) / SR) - 1);
  rowFreq[r] = Math.sqrt(f0 * f1);
}

// Spectrogram of samples [a, b) as COLS columns.
function stft(x, a = 0, b = x.length) {
  const M = new Float32Array(COLS * ROWS), re = new Float32Array(N), im = new Float32Array(N);
  const hop = (b - a) / COLS;
  for (let c = 0; c < COLS; c++) {
    const start = Math.floor(a + c * hop + hop / 2) - N / 2;
    for (let n = 0; n < N; n++) { const j = start + n; re[n] = j >= 0 && j < x.length ? x[j] * win[n] : 0; im[n] = 0; }
    fft(re, im, cosT, sinT);
    for (let r = 0; r < ROWS; r++) {
      let m = 0;
      for (let k = rowLo[r]; k <= rowHi[r]; k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > m) m = v; }
      M[c * ROWS + r] = Math.sqrt(m);
    }
  }
  return M;
}

const level = (m, ref) => Math.max(0, Math.min(1, (20 * Math.log10(m / ref + 1e-12) + DB_RANGE) / DB_RANGE));

function inferno(v) {
  const x = v * (INFERNO.length - 1), i = Math.min(INFERNO.length - 2, Math.floor(x)), f = x - i;
  return INFERNO[i].map((a, k) => a + (INFERNO[i + 1][k] - a) * f);
}

function makeImage(fill) {
  const cv = document.createElement('canvas');
  cv.width = COLS; cv.height = ROWS;
  const g = cv.getContext('2d'), img = g.createImageData(COLS, ROWS);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    const [R, G, B] = fill(c * ROWS + r);
    const p = ((ROWS - 1 - r) * COLS + c) * 4;
    img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

function stats(x, M) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  const rmsDb = 10 * Math.log10(s / x.length + 1e-12);
  let num = 0, den = 0;
  for (let i = 0; i < M.length; i++) { const p = M[i] * M[i]; num += p * rowFreq[i % ROWS]; den += p; }
  return { rmsDb, centroid: den ? num / den : 0 };
}

function niceStep(span) {
  for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (span / s <= 8) return s;
  return 300;
}

// --- Visualizer ------------------------------------------------------------------
export class Visualizer {
  constructor(container, statusEl, toolbarEl) {
    this.el = container; this.statusEl = statusEl; this.toolbar = toolbarEl;
    this.rows = []; this.layers = [];
    this.view = { a: 0, b: 1 }; this.detail = null; this.onSeek = null;
    this.enabled = { base: true }; // layers shown in the consolidated plot
    this.bindInteractions();
  }
  status(msg) { this.statusEl.textContent = msg; }

  // snap: { name, moodColor, original: Float32Array, layers: [{ key, title, sub, color, x, dry }] }, mono at SR
  async show(snap, keepView = false) {
    this.status('Computing spectrograms…');
    await new Promise((r) => setTimeout(r, 0));
    if (!keepView || this.len !== snap.original.length) this.view = { a: 0, b: 1 };
    this.build(snap);
    this.status('');
  }

  build(snap) {
    const len = snap.original.length, mix = new Float32Array(len);
    for (const L of snap.layers) for (let i = 0; i < len; i++) mix[i] += L.x[i] || 0;
    const stages = [{ title: 'Original', sub: `${snap.name} · as recorded`, color: INPUT_COLOR, x: snap.original }];
    for (const L of snap.layers) stages.push({ title: L.title, sub: L.sub, color: L.color, x: L.x, dry: L.dry });
    if (snap.layers.length) stages.push({ title: 'Mood mix', sub: 'every channel with the mood applied (before the bus compressor)', color: snap.moodColor, x: mix, vsOriginal: true });

    const fullM = stages.map((st) => stft(st.x));
    let ref = 1e-9, peak = 1e-9;
    stages.forEach((st, i) => {
      for (const v of fullM[i]) if (v > ref) ref = v;
      for (const v of st.x) if (Math.abs(v) > peak) peak = Math.abs(v);
    });
    stages.forEach((st, i) => {
      st.stats = stats(st.x, fullM[i]);
      const before = st.dry ? stats(st.dry, stft(st.dry)) : st.vsOriginal ? stages[0].stats : null;
      if (before) st.delta = { db: st.stats.rmsDb - before.rmsDb, hz: st.stats.centroid - before.centroid };
    });
    for (const L of snap.layers) this.enabled[L.key] ??= true;
    const composite = {
      title: 'Consolidated · color-coded by channel',
      sub: 'gray = original · color = each channel after the mood. Toggle layers on the right.',
      color: 'conic-gradient(var(--r), var(--g), var(--b), var(--r))',
      composite: true,
      legend: [['base', INPUT_COLOR, 'Original']].concat(snap.layers.map((L) => [L.key, L.color, L.title])),
    };

    Object.assign(this, { stages, layers: snap.layers, ref, peak, len, composite, duration: len / SR });
    composite.x = this.compositeSignal();
    this.overview = this.images(0, len, fullM);
    this.detail = null;
    this.render(stages.concat(composite));
    this.scheduleDetail();
  }

  // Spectrogram images for samples [a, b): one per stage + the composite.
  images(a, b, stageMs) {
    stageMs ??= this.stages.map((st) => stft(st.x, a, b));
    const imgs = stageMs.map((M) => makeImage((j) => inferno(level(M[j], this.ref))));
    const baseM = stageMs[0], layerMs = this.layers.map((_, k) => stageMs[k + 1]);
    imgs.push(this.compositeImage(baseM, layerMs));
    return { a: a / this.len, b: b / this.len, imgs, baseM, layerMs };
  }

  compositeImage(baseM, layerMs) {
    const cols = this.layers.map((L) => hexRgb(L.color));
    const { ref, enabled, layers } = this;
    return makeImage((j) => {
      const g = enabled.base ? 150 * level(baseM[j], ref) ** 2 : 0;
      let R = g, G = g, B = g;
      layerMs.forEach((M, k) => {
        if (!enabled[layers[k].key]) return;
        const v = level(M[j], ref) ** 2;
        R += cols[k][0] * v; G += cols[k][1] * v; B += cols[k][2] * v;
      });
      return [Math.min(255, R), Math.min(255, G), Math.min(255, B)];
    });
  }

  // Sum of the enabled layers (for the consolidated waveform)
  compositeSignal() {
    const out = new Float32Array(this.len);
    if (this.enabled.base) out.set(this.stages[0].x.subarray(0, this.len));
    for (const L of this.layers) if (this.enabled[L.key]) for (let i = 0; i < this.len; i++) out[i] += L.x[i] || 0;
    return out;
  }

  toggleLayer(key) {
    this.enabled[key] = !this.enabled[key];
    for (const src of [this.overview, this.detail]) if (src) src.imgs[src.imgs.length - 1] = this.compositeImage(src.baseM, src.layerMs);
    this.composite.x = this.compositeSignal();
    this.el.querySelectorAll(`[data-layer="${key}"]`).forEach((b) => b.classList.toggle('on', this.enabled[key]));
    this.redraw();
  }

  render(list) {
    this.el.innerHTML = '';
    this.toolbar.classList.remove('hidden');
    this.rows = list.map((st, i) => {
      const row = document.createElement('div');
      row.className = 'viz-row' + (st.composite ? ' composite' : '');
      if (!st.composite) row.style.setProperty('--c', st.color);
      const stat = st.stats
        ? `<span class="chip">loudness ${st.stats.rmsDb.toFixed(1)} dB${st.delta ? ` (${signed(st.delta.db)})` : ''}</span>` +
          `<span class="chip">brightness ${fmtHz(st.stats.centroid)}${st.delta ? ` (${signed(st.delta.hz, 0)} Hz)` : ''}</span>`
        : st.legend.map(([key, c, l]) => `<button class="layer${this.enabled[key] ? ' on' : ''}" data-layer="${key}" style="--c:${c}" aria-pressed="${this.enabled[key]}"><i></i>${l}</button>`).join('');
      row.innerHTML = `
        <div class="viz-head">
          <span class="viz-num" style="background:${st.color}">${i + 1}</span>
          <div><div class="viz-title">${st.title}</div><div class="viz-sub">${st.sub}</div></div>
          <div class="viz-stats">${stat}</div>
        </div>
        <canvas class="viz-canvas" aria-label="${st.title} waveform and spectrogram"></canvas>`;
      this.el.appendChild(row);
      return { st, i, canvas: row.querySelector('canvas'), cache: null };
    });
    this.redraw();
  }

  // ---- View (zoom / pan) ----
  setView(a, b) {
    const minSpan = Math.min(1, MIN_SPAN_SEC / (this.duration || 1));
    let span = Math.max(minSpan, Math.min(1, b - a));
    a = Math.max(0, Math.min(1 - span, a));
    this.view = { a, b: a + span };
    this.redraw();
    this.scheduleDetail();
  }
  zoom(factor, anchor = (this.view.a + this.view.b) / 2) {
    const { a, b } = this.view;
    this.setView(anchor - (anchor - a) * factor, anchor + (b - anchor) * factor);
  }
  scheduleDetail() {
    clearTimeout(this.detailTimer);
    const { a, b } = this.view;
    if (!this.stages || b - a > 0.95) return;
    this.detailTimer = setTimeout(() => {
      const d = this.images(Math.floor(a * this.len), Math.ceil(b * this.len));
      if (this.view.a === a && this.view.b === b) { this.detail = d; this.redraw(); }
    }, 160);
  }
  // Pointer → song fraction. The waveform strip maps the whole track; the spectrogram maps the zoomed view.
  // Returns null in the label gutter.
  songFracAt(canvas, clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const f = (clientX - r.left - GUTTER) / (r.width - GUTTER);
    if (f < 0 || f > 1) return null;
    if (this.inWave(canvas, clientY)) return f;
    return this.view.a + f * (this.view.b - this.view.a);
  }
  inWave(canvas, clientY) {
    return clientY - canvas.getBoundingClientRect().top < (WAVE_H + SPEC_Y) / 2;
  }

  bindInteractions() {
    const isPlot = (t) => t.classList?.contains('viz-canvas');
    this.el.addEventListener('wheel', (e) => {
      if (!isPlot(e.target) || !this.stages) return;
      e.preventDefault();
      const span = this.view.b - this.view.a;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { // horizontal scroll → pan
        const w = e.target.getBoundingClientRect().width - GUTTER;
        const d = ((e.shiftKey ? e.deltaY : 0) + e.deltaX) / w * span;
        this.setView(this.view.a + d, this.view.b + d);
      } else { // scroll wheel / pinch → zoom around the cursor
        const anchor = this.songFracAt(e.target, e.clientX, e.clientY) ?? undefined;
        this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), anchor);
      }
    }, { passive: false });
    this.el.addEventListener('click', (e) => {
      const key = e.target.closest('[data-layer]')?.dataset.layer;
      if (key) this.toggleLayer(key);
    });

    let drag = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (!isPlot(e.target) || !this.stages) return;
      e.target.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, view: { ...this.view }, moved: false, canvas: e.target, wave: this.inWave(e.target, e.clientY) };
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (!drag.moved) return;
      drag.canvas.style.cursor = 'grabbing';
      const w = drag.canvas.getBoundingClientRect().width - GUTTER, span = drag.view.b - drag.view.a;
      // waveform strip: move the zoom window with the pointer; spectrogram: pan the content
      const d = drag.wave ? dx / w : (-dx / w) * span;
      this.setView(drag.view.a + d, drag.view.b + d);
    });
    const end = (e) => {
      if (!drag) return;
      drag.canvas.style.cursor = '';
      if (!drag.moved) { const f = this.songFracAt(drag.canvas, e.clientX, drag.y); if (f != null) this.onSeek?.(f); }
      drag = null;
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('dblclick', (e) => { if (isPlot(e.target)) this.setView(0, 1); });

    this.toolbar.addEventListener('click', (e) => {
      const z = e.target.closest('[data-zoom]')?.dataset.zoom;
      if (!z || !this.stages) return;
      if (z === 'in') this.zoom(0.5);
      else if (z === 'out') this.zoom(2);
      else this.setView(0, 1);
    });
  }

  // ---- Drawing ----
  redraw() {
    if (!this.stages) return;
    const dpr = window.devicePixelRatio || 1, { a, b } = this.view, span = b - a;
    const src = this.detail && this.detail.a <= a + 1e-9 && this.detail.b >= b - 1e-9 ? this.detail : this.overview;
    const t0 = a * this.duration, t1 = b * this.duration;
    const range = this.toolbar.querySelector('.viz-range');
    const rs = niceStep(t1 - t0);
    if (range) range.textContent = `${fmtS(t0, rs)} s – ${fmtS(t1, rs)} s  ·  ×${(1 / span).toFixed(span > 0.1 ? 1 : 0)}`;

    for (const row of this.rows) {
      const { st, canvas, i } = row;
      const W = Math.max(1, canvas.clientWidth * dpr), H = ROW_H * dpr;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const off = row.cache?.width === W ? row.cache : Object.assign(document.createElement('canvas'), { width: W, height: H });
      const g = off.getContext('2d');
      const gut = GUTTER * dpr, waveH = WAVE_H * dpr, specY = SPEC_Y * dpr, specH = H - specY, plotW = W - gut;
      g.fillStyle = '#0b0c10'; g.fillRect(0, 0, W, H);
      if (!st.composite) { // tint the waveform strip with the channel color
        g.globalAlpha = 0.16; g.fillStyle = st.color; g.fillRect(0, 0, W, waveH); g.globalAlpha = 1;
      }

      // Waveform: always the whole track, with a window showing the zoomed range
      const x = st.x, spp = x.length / plotW, mid = waveH / 2;
      const stride = Math.max(1, Math.floor(spp / 32));
      g.fillStyle = st.composite ? '#c9ccd6' : st.color;
      for (let p = 0; p < plotW; p++) {
        let mn = 0, mx = 0;
        const i0 = Math.floor(p * spp), i1 = Math.min(x.length, Math.floor((p + 1) * spp));
        for (let k = i0; k < i1; k += stride) { const v = x[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
        g.fillRect(gut + p, mid - (mx / this.peak) * mid, 1, Math.max(1, ((mx - mn) / this.peak) * mid));
      }
      if (span < 0.999) {
        const wx = gut + a * plotW, ww = Math.max(4 * dpr, span * plotW);
        g.fillStyle = 'rgba(11,12,16,.6)';
        g.fillRect(gut, 0, wx - gut, waveH);
        g.fillRect(wx + ww, 0, W - wx - ww, waveH);
        g.fillStyle = 'rgba(255,255,255,.12)';
        g.fillRect(wx, 0, ww, waveH);
        g.strokeStyle = 'rgba(255,255,255,.85)';
        g.lineWidth = 1.5 * dpr;
        g.strokeRect(wx, 0.75 * dpr, ww, waveH - 1.5 * dpr);
        // guide lines from the window down to the zoomed spectrogram
        g.strokeStyle = 'rgba(255,255,255,.25)';
        g.lineWidth = dpr;
        g.beginPath();
        g.moveTo(wx, waveH); g.lineTo(gut, specY);
        g.moveTo(wx + ww, waveH); g.lineTo(W, specY);
        g.stroke();
      }

      // Spectrogram (crop of best available image)
      const sw = src.b - src.a;
      g.imageSmoothingEnabled = true;
      g.drawImage(src.imgs[i], ((a - src.a) / sw) * COLS, 0, (span / sw) * COLS, ROWS, gut, specY, plotW, specH);

      // Pitch axis: every octave's C labelled (C1 … C9), fainter line at each G
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.fillText('wave', 4 * dpr, mid);
      for (let oct = 1; oct <= 9; oct++) {
        for (const pc of [0, 7]) {
          const f = 440 * 2 ** ((12 * (oct + 1) + pc - 69) / 12);
          if (f < FMIN || f > FMAX) continue;
          const y = specY + specH * (1 - Math.log(f / FMIN) / Math.log(FMAX / FMIN));
          g.fillStyle = pc === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)';
          g.fillRect(gut, y, plotW, 1);
          if (pc === 0) { g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText(`C${oct}`, 6 * dpr, y); }
        }
      }
      // Time axis (seconds)
      const step = niceStep(t1 - t0);
      g.textBaseline = 'bottom';
      for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) {
        const px = gut + ((t - t0) / (t1 - t0)) * plotW;
        g.fillStyle = 'rgba(255,255,255,.10)';
        g.fillRect(px, specY, 1, specH);
        g.fillStyle = 'rgba(255,255,255,.75)';
        g.fillText(fmtS(t, step), px + 3 * dpr, H - 2 * dpr);
      }
      g.font = `600 ${9 * dpr}px system-ui, sans-serif`;
      const cap = 'time (s)', cw = g.measureText(cap).width + 10 * dpr;
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(W - cw - 4 * dpr, H - 16 * dpr, cw, 14 * dpr);
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(cap, W - cw + 1 * dpr, H - 9 * dpr);
      // Panel tags
      const tag = (txt, y) => {
        g.font = `600 ${9 * dpr}px system-ui, sans-serif`;
        g.textBaseline = 'middle';
        const w = g.measureText(txt).width + 10 * dpr;
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(gut + 4 * dpr, y, w, 14 * dpr);
        g.fillStyle = '#fff'; g.fillText(txt, gut + 9 * dpr, y + 7 * dpr);
      };
      tag('WAVEFORM · full track', 3 * dpr);
      tag(st.composite ? 'SPECTROGRAM · channel-colored' : 'SPECTROGRAM', specY + 4 * dpr);
      row.cache = off;
    }
    this.drawPlayhead(this.lastFrac ?? 0);
  }

  drawPlayhead(frac) {
    this.lastFrac = frac;
    const dpr = window.devicePixelRatio || 1, { a, b } = this.view;
    for (const { canvas, cache } of this.rows) {
      if (!cache) continue;
      const g = canvas.getContext('2d');
      g.drawImage(cache, 0, 0);
      const gut = GUTTER * dpr, plotW = canvas.width - gut, specY = SPEC_Y * dpr;
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(gut + frac * plotW, 0, dpr * 1.5, WAVE_H * dpr); // full-track waveform
      if (frac >= a && frac <= b) g.fillRect(gut + ((frac - a) / (b - a)) * plotW, specY, dpr * 1.5, canvas.height - specY);
    }
  }
}
