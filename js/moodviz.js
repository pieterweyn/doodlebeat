// "The mood, per instrument": EQ curves + live spectra (before → after), dynamics/space bars, and the genre map.
import { eqResponse } from './dsp.js';

const FMIN = 20, FMAX = 20000, EQ_DB = 15, SPEC_LO = -110, SPEC_HI = -15, NF = 400;
const FREQS = new Float32Array(NF).map((_, i) => FMIN * (FMAX / FMIN) ** (i / (NF - 1)));
const fx = (f, W) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
const hexA = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

export class MoodScope {
  constructor({ chipsEl, eqCanvas, paramsEl, latentCanvas, latentSub }) {
    Object.assign(this, { chipsEl, eqCanvas, paramsEl, latentCanvas, latentSub });
    this.items = []; this.sel = null; this.settings = {}; this.points = {}; this.trails = {};
    this.weights = {}; this.cfg = null; this.curveCache = {};
    chipsEl.addEventListener('click', (e) => { const k = e.target.closest('[data-key]')?.dataset.key; if (k) this.select(k); });
    this.handles = []; this.drag = null; this.hover = -1; this.onEdit = null;
    this.bindEq();
  }

  // ---- hand EQ: drag a band dot (up/down = gain, left/right = frequency), double-click resets the band ----
  bindEq() {
    const cv = this.eqCanvas;
    const at = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const hit = (x, y) => {
      let best = -1, bd = 16;
      for (const h of this.handles) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h.i; } }
      return best;
    };
    const editable = () => this.current()?.editable && this.onEdit;
    const apply = (x, y, i) => {
      const g = this.geom; if (!g) return;
      const f = FMIN * (FMAX / FMIN) ** Math.max(0, Math.min(1, (x - g.padL) / g.pw));
      const db = ((g.padT + g.ph / 2 - y) / (g.ph / 2)) * EQ_DB;
      this.onEdit(this.current().key, i, { gain: Math.max(-EQ_DB, Math.min(EQ_DB, db)), freq: f });
    };
    cv.addEventListener('pointerdown', (e) => {
      if (!editable()) return;
      const [x, y] = at(e), i = hit(x, y);
      if (i < 0) return;
      cv.setPointerCapture(e.pointerId);
      this.drag = { i };
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = at(e);
      if (this.drag) { apply(x, y, this.drag.i); return; }
      this.hover = editable() ? hit(x, y) : -1;
      cv.style.cursor = this.hover >= 0 ? 'grab' : '';
    });
    const end = () => { this.drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('dblclick', (e) => {
      if (!editable()) return;
      const [x, y] = at(e), i = hit(x, y);
      if (i >= 0) this.onEdit(this.current().key, i, { reset: true });
    });
  }
  setConfig(cfg) { this.cfg = cfg; }

  // items: [{ key, label, color, instrument, chain? }]
  setItems(items) {
    this.items = items;
    if (!items.find((i) => i.key === this.sel)) this.sel = items[0]?.key ?? null;
    this.chipsEl.innerHTML = items.map((i) =>
      `<button data-key="${i.key}" style="--c:${i.color}" aria-pressed="${i.key === this.sel}"><i></i>${i.label}</button>`).join('');
    this.renderParams();
  }
  select(key) {
    this.sel = key;
    this.chipsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.key === key));
    this.renderParams();
  }
  // byInstrument: { inst: { settings, latent } }, weights: genre blend
  setMood(byInstrument, weights) {
    this.byInst = byInstrument; this.weights = weights; this.curveCache = {};
    for (const [inst, v] of Object.entries(byInstrument)) {
      const t = (this.trails[inst] ??= []);
      const last = t[t.length - 1];
      if (!last || Math.hypot(last[0] - v.latent[0], last[1] - v.latent[1]) > 1e-3) t.push(v.latent);
      if (t.length > 40) t.shift();
    }
    this.renderParams();
  }
  current() { return this.items.find((i) => i.key === this.sel); }
  settingsOf(item) { return item?.getSettings?.() ?? this.byInst?.[item?.instrument]?.settings; }

  // ---- parameter bars ----
  renderParams() {
    const item = this.current(), s = this.settingsOf(item), cfg = this.cfg;
    if (!item || !s || !cfg) { this.paramsEl.innerHTML = '<p class="hint">Set a mood to see the settings.</p>'; return; }
    const rows = cfg.schema.bands.map((b, i) => ({ name: b.label, v: s.eq[i], c: 0, r: 12, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` }))
      .concat([
        { name: 'Comp', v: s.comp, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
        { name: 'Sat', v: s.sat, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
        { name: 'Reverb', v: s.reverb, c: null, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
        { name: 'Width', v: s.width, c: 1, r: 1, fmt: (v) => `${Math.round(v * 100)}%` },
        { name: 'Level', v: s.level, c: 0, r: 12, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
      ]);
    this.paramsEl.innerHTML = rows.map((r) => {
      let left, width;
      if (r.c === null) { left = 0; width = Math.min(1, r.v / r.r) * 100; }
      else { const d = Math.max(-1, Math.min(1, (r.v - r.c) / r.r)); left = 50 + Math.min(0, d) * 50; width = Math.abs(d) * 50; }
      return `<div class="prow" style="--c:${item.color}"><span>${r.name}</span><div class="ptrack">${r.c !== null ? '<span class="mid"></span>' : ''}<i style="left:${left}%;width:${width}%"></i></div><b>${r.fmt(r.v)}${['Low', 'Low-mid', 'Mid', 'Presence', 'Air', 'Level'].includes(r.name) ? ' dB' : ''}</b></div>`;
    }).join('');
  }

  // ---- per-frame drawing ----
  frame(playing) {
    this.drawEq(playing);
    this.drawLatent();
  }

  curve(item, s = this.settingsOf(item)) {
    if (!s || !this.cfg) return null;
    const key = s.eq.join(',') + '|' + (s.freqs || []).join(',');
    if (Object.keys(this.curveCache).length > 200) this.curveCache = {};
    return (this.curveCache[key] ??= eqResponse(this.cfg.schema, s.eq, FREQS, s.freqs));
  }

  drawEq(playing) {
    const cv = this.eqCanvas, dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, cv.clientWidth * dpr), H = Math.max(1, cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const padL = 8 * dpr, padR = 40 * dpr, padT = 10 * dpr, padB = 22 * dpr, pw = W - padL - padR, ph = H - padT - padB;
    const X = (f) => padL + fx(f, pw), Ydb = (db) => padT + ph / 2 - (db / EQ_DB) * (ph / 2);
    this.geom = { padL: padL / dpr, pw: pw / dpr, padT: padT / dpr, ph: ph / dpr };
    this.handles = [];

    // grid
    g.font = `${10 * dpr}px Manrope, system-ui, sans-serif`; g.textBaseline = 'top';
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(X(f), padT, dpr, ph);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, X(f) + 3 * dpr, H - padB + 6 * dpr);
    }
    g.textBaseline = 'middle';
    for (const db of [-12, -6, 0, 6, 12]) {
      g.fillStyle = db === 0 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.06)'; g.fillRect(padL, Ydb(db), pw, dpr);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(`${db > 0 ? '+' : ''}${db} dB`, W - padR + 6 * dpr, Ydb(db));
    }

    // axis symbols: f (frequency) along x, G (gain, dB) along y
    g.font = `italic 600 ${15 * dpr}px "Bodoni Moda", Georgia, serif`;
    g.fillStyle = 'rgba(255,255,255,.8)';
    g.textBaseline = 'top';
    g.fillText('f', padL + 4 * dpr, H - padB + 3 * dpr);       // start of the frequency axis
    g.fillText('G', W - padR + 10 * dpr, 14 * dpr);            // above the dB scale, clear of the frame
    g.font = `${10 * dpr}px Manrope, system-ui, sans-serif`;

    const item = this.current();
    // live spectra of the selected channel: before (gray) → after (color)
    if (playing && item?.chain?.pre) {
      for (const [an, fill] of [[item.chain.pre, 'rgba(255,255,255,.13)'], [item.chain.post, hexA(item.color, 0.32)]]) {
        const data = (an._buf ??= new Float32Array(an.frequencyBinCount));
        an.getFloatFrequencyData(data);
        const sr = an.context.sampleRate, binHz = sr / an.fftSize, cols = Math.floor(pw / (2 * dpr));
        g.beginPath(); g.moveTo(padL, padT + ph);
        for (let c = 0; c <= cols; c++) {
          const f0 = FMIN * (FMAX / FMIN) ** (c / cols), f1 = FMIN * (FMAX / FMIN) ** ((c + 1) / cols);
          let m = -Infinity;
          for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(data.length - 1, Math.ceil(f1 / binHz)); k++) if (data[k] > m) m = data[k];
          const v = Math.max(0, Math.min(1, (m - SPEC_LO) / (SPEC_HI - SPEC_LO)));
          g.lineTo(padL + (c / cols) * pw, padT + ph - v * ph);
        }
        g.lineTo(padL + pw, padT + ph); g.closePath(); g.fillStyle = fill; g.fill();
      }
    }
    // EQ curves: every channel faint, selected bold with band handles
    const drawCurve = (it, bold, s, dashed = false) => {
      const r = this.curve(it, s); if (!r) return;
      g.setLineDash(dashed ? [5 * dpr, 5 * dpr] : []);
      g.beginPath();
      for (let i = 0; i < NF; i++) { const x = X(FREQS[i]), y = Ydb(Math.max(-EQ_DB, Math.min(EQ_DB, r[i]))); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = dashed ? 'rgba(255,255,255,.6)' : bold ? it.color : hexA(it.color, 0.35);
      g.lineWidth = (bold ? 3 : 1.4) * dpr; g.shadowColor = it.color; g.shadowBlur = bold ? 14 * dpr : 0;
      g.stroke(); g.shadowBlur = 0; g.setLineDash([]);
    };
    for (const it of this.items) if (it !== item) drawCurve(it, false);
    if (item) {
      if (item.edited?.()) drawCurve(item, false, item.getMoodSettings(), true); // the mood's own curve, dashed
      drawCurve(item, true);
      const s = this.settingsOf(item);
      if (s) this.cfg.schema.bands.forEach((b, i) => {
        const x = X(s.freqs?.[i] ?? b.freq), y = Ydb(Math.max(-EQ_DB, Math.min(EQ_DB, s.eq[i])));
        if (item.editable) this.handles.push({ i, x: x / dpr, y: y / dpr });
        const big = item.editable && (this.hover === i || this.drag?.i === i);
        g.beginPath(); g.arc(x, y, (big ? 8 : item.editable ? 6.5 : 5) * dpr, 0, Math.PI * 2);
        g.fillStyle = big ? item.color : '#0b0b10'; g.fill();
        g.lineWidth = 2 * dpr; g.strokeStyle = item.color; g.stroke();
        g.fillStyle = 'rgba(255,255,255,.75)'; g.textBaseline = 'bottom'; g.textAlign = 'center';
        g.fillText(b.label, x, y - 11 * dpr); g.textAlign = 'left';
      });
    }
  }

  drawLatent() {
    const cv = this.latentCanvas, dpr = window.devicePixelRatio || 1, cfg = this.cfg, item = this.current();
    const W = Math.max(1, cv.clientWidth * dpr), H = Math.max(1, cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (!cfg || !item) return;
    const inst = cfg.latent[item.instrument] ? item.instrument : 'other', pts = cfg.latent[inst];
    this.latentSub.textContent = `· ${inst}`;
    const all = Object.values(pts);
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 28 * dpr, sx = (W - 2 * pad) / (x1 - x0 || 1), sy = (H - 2 * pad) / (y1 - y0 || 1), s = Math.min(sx, sy);
    const cx = (W - (x1 - x0) * s) / 2, cy = (H - (y1 - y0) * s) / 2;
    const P = (p) => [cx + (p[0] - x0) * s, H - (cy + (p[1] - y0) * s)];
    const cur = this.byInst?.[inst]?.latent;

    g.font = `italic 600 ${13 * dpr}px "Bodoni Moda", Georgia, serif`; g.textAlign = 'center';
    for (const gn of cfg.genres) {
      const [x, y] = P(pts[gn.id]), w = this.weights[gn.id] || 0;
      if (cur && w > 0.01) {
        const [ux, uy] = P(cur);
        g.strokeStyle = hexA(gn.color, Math.min(1, 0.15 + w)); g.lineWidth = (1 + w * 3) * dpr;
        g.beginPath(); g.moveTo(x, y); g.lineTo(ux, uy); g.stroke();
      }
      g.beginPath(); g.arc(x, y, (5 + w * 6) * dpr, 0, Math.PI * 2); g.fillStyle = gn.color; g.fill();
      g.fillStyle = '#fff'; g.textBaseline = 'bottom'; g.fillText(gn.name, x, y - 9 * dpr);
    }
    const [nx, ny] = P(pts._neutral);
    g.beginPath(); g.arc(nx, ny, 6 * dpr, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5 * dpr; g.stroke();
    g.font = `${10 * dpr}px Manrope, sans-serif`; g.fillStyle = 'rgba(255,255,255,.6)'; g.textBaseline = 'top';
    g.fillText('as recorded', nx, ny + 9 * dpr);
    const trail = this.trails[inst] || [];
    trail.forEach((p, i) => {
      const [x, y] = P(p);
      g.beginPath(); g.arc(x, y, 2 * dpr, 0, Math.PI * 2); g.fillStyle = hexA(item.color, (i + 1) / trail.length * 0.5); g.fill();
    });
    if (cur) {
      const [x, y] = P(cur);
      g.beginPath(); g.arc(x, y, 8 * dpr, 0, Math.PI * 2);
      g.fillStyle = item.color; g.shadowColor = item.color; g.shadowBlur = 18 * dpr; g.fill(); g.shadowBlur = 0;
      g.lineWidth = 2 * dpr; g.strokeStyle = '#fff'; g.stroke();
    }
    g.textAlign = 'left';
  }
}
