// "The mood, per instrument": a Logic / Final Cut style Channel EQ (band toggles, curve + dots, value strip),
// live spectra (before → after), every EQ as a thumbnail in the legend, and a channel's dynamics/space bars.
import { eqResponse, isCut, EQ_DB, Q_MIN, Q_MAX, SLOPES } from './dsp.js';

const FMIN = 20, FMAX = 20000, SPEC_LO = -110, SPEC_HI = -15, NF = 400;
const FREQS = new Float32Array(NF).map((_, i) => FMIN * (FMAX / FMIN) ** (i / (NF - 1)));
const fx = (f, W) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
const hexA = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const fmtDb = (g) => `${g > 0.05 ? '+' : ''}${g.toFixed(1)} dB`;

// band-shape icons (Logic's top row)
const ICONS = {
  highpass: 'M3 18 C8 18 9 7 14 7 L25 7',
  lowshelf: 'M3 7 L8 7 C12 7 12 13 16 13 L25 13',
  peaking: 'M3 13 L8 13 C11 13 11 6 14 6 C17 6 17 13 20 13 L25 13',
  highshelf: 'M3 13 L12 13 C16 13 16 7 20 7 L25 7',
  lowpass: 'M3 7 L14 7 C19 7 20 18 25 18',
};

export class MoodScope {
  constructor({ chipsEl, eqCanvas, bandBarEl, valuesEl, paramsEl }) {
    Object.assign(this, { chipsEl, eqCanvas, bandBarEl, valuesEl, paramsEl });
    this.items = []; this.sel = null; this.cfg = null; this.defs = [];
    this.curveCache = new Map(); this.band = -1; this.handles = []; this.drag = null; this.hover = -1; this.onEdit = null;
    chipsEl.addEventListener('click', (e) => { const k = e.target.closest('[data-key]')?.dataset.key; if (k) this.select(k); });
    this.bindCanvas(); this.bindBandBar(); this.bindValues();
  }
  setConfig(cfg, defs) {
    this.cfg = cfg; this.defs = defs;
    this.bandBarEl.innerHTML = defs.map((d, i) =>
      `<button data-band="${i}" style="--bc:${d.color}" title="${esc(d.label)}: click to switch on/off" aria-label="${esc(d.label)} on/off">` +
      `<svg viewBox="0 0 28 22" aria-hidden="true"><path d="${ICONS[d.type]}"/></svg></button>`).join('');
    this.valuesEl.innerHTML = defs.map((d, i) => `<div class="eqv" data-band="${i}" style="--bc:${d.color}">
      <span class="v" data-field="freq" title="Frequency: drag up/down · double-click to type"></span>
      <span class="v" data-field="${isCut(d.type) ? 'slope' : 'gain'}" title="${isCut(d.type) ? 'Slope: click to change' : 'Gain: drag up/down · double-click to type'}"></span>
      <span class="v" data-field="q" title="${d.type.endsWith('shelf') ? 'Shelves have a fixed slope' : 'Q: drag up/down · double-click to type'}"></span>
    </div>`).join('');
  }

  // ---- items: [{ key, label, color, mix?, instrument?, chain?, editable, getBands(), getMoodBands?(), getSettings?(), edited?() }] ----
  setItems(items) {
    this.items = items;
    if (!items.find((i) => i.key === this.sel)) this.sel = items[0]?.key ?? null;
    this.chipsEl.innerHTML = items.map((i) =>
      `<button data-key="${esc(i.key)}" class="${i.mix ? 'is-mix' : ''}" style="--c:${i.color}" aria-pressed="${i.key === this.sel}" title="${esc(i.label)}">` +
      `<canvas aria-hidden="true"></canvas><span class="lbl"><i></i>${esc(i.label)}</span></button>`).join('');
    this.thumbs = [...this.chipsEl.querySelectorAll('button')].map((btn, k) => ({ item: items[k], btn, cv: btn.querySelector('canvas'), color: items[k].color }));
    this.refresh();
  }
  select(key) {
    this.sel = key;
    this.chipsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === key));
    this.refresh();
  }
  current() { return this.items.find((i) => i.key === this.sel); }
  bandsOf(item) { return item?.getBands?.() ?? null; }
  refresh() { this.renderBands(); this.renderParams(); }
  edit(i, patch) { const it = this.current(); if (it?.editable && this.onEdit) this.onEdit(it.key, i, patch); }

  // ---- band toggles + value strip ----
  renderBands() {
    const item = this.current(), bands = this.bandsOf(item), editable = !!item?.editable;
    this.bandBarEl.querySelectorAll('button').forEach((b, i) => {
      b.setAttribute('aria-pressed', !!bands?.[i]?.on); b.disabled = !editable;
      b.classList.toggle('sel', i === this.band);
    });
    this.valuesEl.querySelectorAll('.eqv').forEach((col, i) => {
      const b = bands?.[i], d = this.defs[i];
      col.classList.toggle('off', !b?.on); col.classList.toggle('sel', i === this.band); col.classList.toggle('ro', !editable);
      const [f, g, q] = col.querySelectorAll('.v');
      f.textContent = b ? fmtHz(b.freq) : '–';
      g.textContent = !b ? '–' : isCut(d.type) ? `${b.slope} dB/Oct` : fmtDb(b.gain);
      q.textContent = !b ? '–' : d.type.endsWith('shelf') ? '–' : b.q.toFixed(2);
    });
  }
  bindBandBar() {
    this.bandBarEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-band]'); if (!btn) return;
      const i = +btn.dataset.band, b = this.bandsOf(this.current())?.[i]; if (!b) return;
      this.band = i; this.edit(i, { on: !b.on }); this.renderBands();
    });
  }
  bindValues() {
    const el = this.valuesEl;
    let drag = null;
    const fieldOf = (e) => { const v = e.target.closest('.v'); return v && { v, i: +v.closest('.eqv').dataset.band, field: v.dataset.field }; };
    el.addEventListener('pointerdown', (e) => {
      const t = fieldOf(e); if (!t) return;
      this.band = t.i; this.renderBands();
      const b = this.bandsOf(this.current())?.[t.i]; if (!b || !this.current()?.editable) return;
      if (t.field === 'slope') { this.edit(t.i, { slope: SLOPES[(SLOPES.indexOf(b.slope) + 1) % SLOPES.length], on: true }); return; }
      if (t.field === 'q' && this.defs[t.i].type.endsWith('shelf')) return;
      drag = { ...t, y0: e.clientY, b0: { ...b } };
      t.v.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = drag.y0 - e.clientY, { b0 } = drag; // up = more
      if (drag.field === 'freq') this.edit(drag.i, { freq: clamp(b0.freq * 2 ** (dy / 40), FMIN, FMAX) });
      else if (drag.field === 'gain') this.edit(drag.i, { gain: clamp(b0.gain + dy * 0.1, -EQ_DB, EQ_DB) });
      else if (drag.field === 'q') this.edit(drag.i, { q: clamp(b0.q * 2 ** (dy / 60), Q_MIN, Q_MAX) });
    });
    const end = () => { drag = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => {
      const t = fieldOf(e); if (!t || t.field === 'slope' || !this.current()?.editable) return;
      if (t.field === 'q' && this.defs[t.i].type.endsWith('shelf')) return;
      const b = this.bandsOf(this.current())?.[t.i]; if (!b) return;
      const input = Object.assign(document.createElement('input'), { className: 'eqv-input', value: t.field === 'freq' ? Math.round(b.freq) : t.field === 'gain' ? b.gain.toFixed(1) : b.q.toFixed(2) });
      t.v.replaceChildren(input); input.focus(); input.select();
      const commit = (ok) => {
        input.remove();
        let v = parseFloat(input.value);
        if (ok && Number.isFinite(v)) {
          if (t.field === 'freq') { if (/k/i.test(input.value)) v *= 1000; this.edit(t.i, { freq: clamp(v, FMIN, FMAX) }); }
          else if (t.field === 'gain') this.edit(t.i, { gain: clamp(v, -EQ_DB, EQ_DB) });
          else this.edit(t.i, { q: clamp(v, Q_MIN, Q_MAX) });
        }
        this.renderBands();
      };
      input.addEventListener('keydown', (k) => { if (k.key === 'Enter') commit(true); if (k.key === 'Escape') commit(false); });
      input.addEventListener('blur', () => input.isConnected && commit(true));
    });
  }

  // ---- the graph: drag a dot (left/right = frequency, up/down = gain; cuts: up/down = Q),
  //      Alt-drag or scroll = Q, double-click a dot = reset the band ----
  bindCanvas() {
    const cv = this.eqCanvas;
    const at = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hit = (x, y) => {
      let best = -1, bd = 16;
      for (const h of this.handles) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.i; } }
      return best;
    };
    const editable = () => this.current()?.editable && this.onEdit;
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = at(e), i = hit(x, y);
      if (i < 0) return;
      this.band = i; this.renderBands();
      if (!editable()) return;
      cv.setPointerCapture(e.pointerId);
      this.drag = { i, x0: x, y0: y, b0: { ...this.bandsOf(this.current())[i] } };
      cv.style.cursor = 'grabbing';
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = at(e), g = this.geom;
      if (this.drag && g) {
        const { i, x0, y0, b0 } = this.drag, type = this.defs[i].type, dbPerPx = EQ_DB / (g.ph / 2);
        const patch = { freq: clamp(b0.freq * (FMAX / FMIN) ** ((x - x0) / g.pw), FMIN, FMAX) };
        if (e.altKey || isCut(type)) { if (!type.endsWith('shelf')) patch.q = clamp(b0.q * 2 ** ((y0 - y) / 50), Q_MIN, Q_MAX); }
        else patch.gain = clamp(b0.gain + (y0 - y) * dbPerPx * (type.endsWith('shelf') ? 2 : 1), -EQ_DB, EQ_DB); // a shelf's dot sits at half its gain
        this.edit(i, patch);
        return;
      }
      this.hover = hit(x, y);
      cv.style.cursor = this.hover >= 0 ? (editable() ? 'grab' : 'pointer') : '';
    });
    const end = () => { if (this.drag) { this.drag = null; cv.style.cursor = this.hover >= 0 ? 'grab' : ''; } };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.hover = -1; });
    cv.addEventListener('dblclick', (e) => {
      if (!editable()) return;
      const [x, y] = at(e), i = hit(x, y);
      if (i >= 0) this.edit(i, { reset: true });
    });
    cv.addEventListener('wheel', (e) => {
      const i = this.hover >= 0 ? this.hover : this.band, b = this.bandsOf(this.current())?.[i];
      if (!editable() || !b?.on || this.defs[i].type.endsWith('shelf')) return;
      e.preventDefault();
      this.band = i;
      this.edit(i, { q: clamp(b.q * 1.08 ** (e.deltaY < 0 ? 1 : -1), Q_MIN, Q_MAX) });
    }, { passive: false });
  }

  // ---- side: dynamics and space (the EQ is in the strip under the graph) ----
  renderParams() {
    const item = this.current(), s = item?.getSettings?.();
    if (!item || item.mix || !s) { this.paramsEl.innerHTML = ''; return; } // the mix has only its EQ
    const rows = [
      { name: 'Comp', v: s.comp, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { name: 'Sat', v: s.sat, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { name: 'Reverb', v: s.reverb, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { name: 'Width', v: s.width, c: 1, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
      { name: 'Level', v: s.level, c: 0, r: 12, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
    ];
    this.paramsEl.innerHTML = rows.map((r) => {
      let left, width;
      if (r.c === null) { left = 0; width = Math.min(1, r.v / r.r) * 100; }
      else { const d = Math.max(-1, Math.min(1, (r.v - r.c) / r.r)); left = 50 + Math.min(0, d) * 50; width = Math.abs(d) * 50; }
      return `<div class="prow" style="--c:${item.color}"><span>${r.name}</span><div class="ptrack">${r.c !== null ? '<span class="mid"></span>' : ''}<i style="left:${left}%;width:${width}%"></i></div><b>${r.fmt(r.v)}</b></div>`;
    }).join('');
  }

  // ---- per-frame drawing ----
  frame(playing) {
    this.frameNo = (this.frameNo || 0) + 1;
    this.drawEq(playing);
    this.drawThumbs(playing);
  }
  curve(bands) {
    if (!bands) return null;
    const key = JSON.stringify(bands);
    if (!this.curveCache.has(key)) { if (this.curveCache.size > 300) this.curveCache.clear(); this.curveCache.set(key, eqResponse(bands, FREQS)); }
    return this.curveCache.get(key);
  }
  // where a band's dot sits: on its own response at its frequency (a shelf's at half its gain, a cut's at −3 dB)
  dotDb(band) { return eqResponse([band], new Float32Array([band.freq]))[0]; }

  // Live spectrum of one analyser as a filled shape over [x0, x0+w] × [y0, y0+h].
  spectrum(g, an, x0, y0, w, h, cols, fill) {
    const data = (an._buf ??= new Float32Array(an.frequencyBinCount));
    if (an._frame !== this.frameNo) { an.getFloatFrequencyData(data); an._frame = this.frameNo; } // shared by the big view and its thumbnail
    const binHz = an.context.sampleRate / an.fftSize;
    g.beginPath(); g.moveTo(x0, y0 + h);
    for (let c = 0; c <= cols; c++) {
      const f0 = FMIN * (FMAX / FMIN) ** (c / cols), f1 = FMIN * (FMAX / FMIN) ** ((c + 1) / cols);
      let m = -Infinity;
      for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(data.length - 1, Math.ceil(f1 / binHz)); k++) if (data[k] > m) m = data[k];
      const v = Math.max(0, Math.min(1, (m - SPEC_LO) / (SPEC_HI - SPEC_LO)));
      g.lineTo(x0 + (c / cols) * w, y0 + h - v * h);
    }
    g.lineTo(x0 + w, y0 + h); g.closePath(); g.fillStyle = fill; g.fill();
  }

  drawEq(playing) {
    const cv = this.eqCanvas, dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, cv.clientWidth * dpr), H = Math.max(1, cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const padL = 8 * dpr, padR = 40 * dpr, padT = 10 * dpr, padB = 22 * dpr, pw = W - padL - padR, ph = H - padT - padB;
    const X = (f) => padL + fx(f, pw), Ydb = (db) => padT + ph / 2 - (clamp(db, -EQ_DB, EQ_DB) / EQ_DB) * (ph / 2);
    this.geom = { pw: pw / dpr, ph: ph / dpr };
    this.handles = [];

    // grid
    g.font = `${10 * dpr}px Manrope, system-ui, sans-serif`; g.textBaseline = 'top';
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(X(f), padT, dpr, ph);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, X(f) + 3 * dpr, H - padB + 6 * dpr);
    }
    g.textBaseline = 'middle';
    for (let db = -EQ_DB + 6; db < EQ_DB; db += 6) {
      g.fillStyle = db === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.06)'; g.fillRect(padL, Ydb(db), pw, dpr);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(`${db > 0 ? '+' : ''}${db} dB`, W - padR + 6 * dpr, Ydb(db));
    }
    g.font = `italic 600 ${15 * dpr}px "Bodoni Moda", Georgia, serif`;
    g.fillStyle = 'rgba(255,255,255,.8)'; g.textBaseline = 'top';
    g.fillText('f', padL + 4 * dpr, H - padB + 3 * dpr);
    g.fillText('G', W - padR + 10 * dpr, 14 * dpr);

    const item = this.current(), bands = this.bandsOf(item);
    // live spectra of the selected EQ (a channel, or the whole mix): before (gray) → after (color)
    if (playing && item?.chain?.pre) {
      const cols = Math.floor(pw / (2 * dpr));
      this.spectrum(g, item.chain.pre, padL, padT, pw, ph, cols, 'rgba(255,255,255,.13)');
      this.spectrum(g, item.chain.post, padL, padT, pw, ph, cols, hexA(item.color, 0.32));
    }
    if (item) {
      g.font = `italic 600 ${14 * dpr}px "Bodoni Moda", Georgia, serif`; g.textBaseline = 'top';
      g.fillStyle = item.color; g.fillText(item.mix ? 'Mix EQ' : item.label, padL + 10 * dpr, padT + 8 * dpr);
    }
    g.font = `${10 * dpr}px Manrope, system-ui, sans-serif`;

    const line = (r, color, width, dash = null, glow = 0) => {
      g.setLineDash(dash ? dash.map((d) => d * dpr) : []);
      g.beginPath();
      for (let i = 0; i < NF; i++) { const x = X(FREQS[i]), y = Ydb(r[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = color; g.lineWidth = width * dpr; g.shadowColor = color; g.shadowBlur = glow * dpr;
      g.stroke(); g.shadowBlur = 0; g.setLineDash([]);
    };
    for (const it of this.items) if (it !== item) { const r = this.curve(this.bandsOf(it)); if (r) line(r, hexA(it.color, 0.3), 1.3); }
    if (!item || !bands) return;
    // the selected band's own shape, shaded (as Logic does)
    const sb = bands[this.band];
    if (sb?.on) {
      const r = this.curve([sb]), z = Ydb(0);
      g.beginPath(); g.moveTo(X(FREQS[0]), z);
      for (let i = 0; i < NF; i++) g.lineTo(X(FREQS[i]), Ydb(r[i]));
      g.lineTo(X(FREQS[NF - 1]), z); g.closePath();
      g.fillStyle = hexA(this.defs[this.band].color, 0.16); g.fill();
    }
    if (item.getMoodBands && item.edited?.()) line(this.curve(item.getMoodBands()), 'rgba(255,255,255,.55)', 1.4, [5, 5]); // the mood's own curve
    line(this.curve(bands), item.color, 3, null, 14);

    // dots, one per band that is on
    let readout = null;
    bands.forEach((b, i) => {
      if (!b.on) return;
      const d = this.defs[i], x = X(b.freq), y = Ydb(this.dotDb(b));
      this.handles.push({ i, x: x / dpr, y: y / dpr });
      const active = this.drag?.i === i || this.hover === i, sel = i === this.band;
      g.beginPath(); g.arc(x, y, (active ? 8 : sel ? 7 : 5.5) * dpr, 0, Math.PI * 2);
      g.fillStyle = d.color; g.fill();
      g.lineWidth = (sel ? 2.5 : 1.5) * dpr; g.strokeStyle = sel ? '#fff' : '#0b0b10'; g.stroke();
      if (active) readout = { x, y, b, d };
    });
    if (readout) {
      const { x, y, b, d } = readout;
      const txt = [fmtHz(b.freq), isCut(d.type) ? `${b.slope} dB/Oct` : fmtDb(b.gain), d.type.endsWith('shelf') ? null : `Q ${b.q.toFixed(2)}`].filter(Boolean).join('  ·  ');
      g.font = `600 ${11 * dpr}px Manrope, system-ui, sans-serif`;
      const tw = g.measureText(txt).width + 14 * dpr, th = 20 * dpr;
      const bx = clamp(x - tw / 2, padL, padL + pw - tw), by = y - 16 * dpr - th < padT ? y + 14 * dpr : y - 16 * dpr - th;
      g.fillStyle = 'rgba(11,11,16,.92)'; g.strokeStyle = d.color; g.lineWidth = dpr;
      g.beginPath(); g.roundRect(bx, by, tw, th, 6 * dpr); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(txt, bx + 7 * dpr, by + th / 2);
    }
  }

  // The legend: every EQ (mix + channels) as a small curve over its live output spectrum.
  drawThumbs(playing) {
    const dpr = window.devicePixelRatio || 1, TH_DB = 9; // tighter than the big view so small moves still read
    for (const t of this.thumbs || []) {
      const { item, cv, btn } = t;
      if (t.color !== item.color) { t.color = item.color; btn.style.setProperty('--c', item.color); } // the mix follows the mood color
      const W = Math.max(1, cv.clientWidth * dpr), H = Math.max(1, cv.clientHeight * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      const pad = 3 * dpr, ph = H - 2 * pad, Y = (db) => pad + ph / 2 - (clamp(db, -TH_DB, TH_DB) / TH_DB) * (ph / 2);
      if (playing && item.chain?.post) this.spectrum(g, item.chain.post, 0, pad, W, ph, Math.floor(W / (3 * dpr)), hexA(item.color, 0.22));
      g.fillStyle = 'rgba(255,255,255,.14)'; g.fillRect(0, Y(0), W, dpr);
      const r = this.curve(this.bandsOf(item)); if (!r) continue;
      g.beginPath();
      for (let i = 0; i < NF; i += 2) { const x = (i / (NF - 1)) * W, y = Y(r[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = item.color; g.lineWidth = (item.key === this.sel ? 2 : 1.5) * dpr; g.stroke();
    }
  }
}
