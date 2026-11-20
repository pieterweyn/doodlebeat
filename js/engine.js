// Live playback of the channels (stems) through their mood chains.
// Before the stems are ready the original song plays straight through.
import { createChain, createEq, createReverb, NEUTRAL } from './dsp.js';

export class Engine {
  constructor() {
    this.ctx = null; this.graph = null;
    this.original = null;
    this.channels = new Map(); // id → { buffer, levels, levelPos, textureWet, chain, texDry, levelGains, settings, gainDb, muted, solo }
    this.bypass = false; this.loop = true; this.mixEq = null; // combined EQ on the mix bus: [band ×8], null = flat
    this.playing = false; this.pausedAt = 0; this.srcs = []; this.t0 = 0;
    this.onEnded = null;
  }
  get context() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.6;
    }
    return this.ctx;
  }

  ensureGraph() {
    if (this.graph) return this.graph;
    const ctx = this.context;
    const master = ctx.createGain(), bus = ctx.createDynamicsCompressor(), direct = ctx.createGain();
    bus.threshold.value = -14; bus.ratio.value = 3; bus.attack.value = 0.01; bus.release.value = 0.2;
    // The combined EQ sits on both paths: the stems' bus, and the original song before the stems arrive.
    const mixEq = createEq(ctx, true), directEq = createEq(ctx, true);
    master.connect(mixEq.input); mixEq.output.connect(bus); bus.connect(this.analyser); this.analyser.connect(ctx.destination);
    direct.connect(directEq.input); directEq.output.connect(this.analyser);
    const reverb = createReverb(ctx, master);
    this.graph = { master, bus, direct, reverb, mixEq, directEq };
    this.applyMixEq(true);
    return this.graph;
  }
  setMixEq(bands) { this.mixEq = bands; this.applyMixEq(); }
  applyMixEq(immediate = false) {
    if (!this.graph) return;
    const s = this.bypass ? null : this.mixEq; // Mood off = as recorded
    this.graph.mixEq.apply(s, immediate); this.graph.directEq.apply(s, immediate);
  }
  // before/after analysers of the combined EQ on whichever path is playing
  get mixStage() { return this.graph ? (this.mode === 'stems' ? this.graph.mixEq : this.graph.directEq) : null; }

  get duration() {
    let d = 0;
    for (const ch of this.channels.values()) d = Math.max(d, ch.buffer?.duration || 0);
    return d || this.original?.duration || 0;
  }
  get mode() { return this.channels.size ? 'stems' : 'original'; }

  // ---- Channels ----
  setOriginal(buffer) { this.stop(); this.original = buffer; this.pausedAt = 0; }
  clearChannels() {
    for (const ch of this.channels.values()) ch.chain.disconnect();
    this.channels.clear();
  }
  addChannel(id, buffer, opts = {}, restart = true) {
    const g = this.ensureGraph(), ctx = this.ctx;
    const chain = createChain(ctx, { out: g.master, reverb: g.reverb, analysers: true });
    const texDry = ctx.createGain();
    texDry.connect(chain.input);
    this.channels.set(id, { buffer, levels: [], levelGains: [], levelPos: 1, textureWet: 0, chain, texDry, settings: NEUTRAL, gainDb: 0, muted: false, solo: false, ...opts });
    this.apply(id, true);
    if (restart) this.restartIfPlaying();
  }
  setBuffer(id, buffer) { const ch = this.channels.get(id); if (ch) { ch.buffer = buffer; this.setLevels(id, [], false); this.restartIfPlaying(); } }
  // RAVE levels: the same stem decoded at a few positions along one latent dimension. The color picks a
  // position between them (equal-power crossfade), the wet amount blends them with the dry stem.
  setLevels(id, buffers, restart = true) {
    const ch = this.channels.get(id); if (!ch) return;
    for (const g of ch.levelGains) g.disconnect();
    ch.levels = buffers;
    ch.levelGains = buffers.map(() => { const g = this.ctx.createGain(); g.gain.value = 0; g.connect(ch.chain.input); return g; });
    this.apply(id, true);
    if (restart) this.restartIfPlaying();
  }
  setLevelPos(id, pos) { const ch = this.channels.get(id); if (ch) { ch.levelPos = pos; this.apply(id); } }
  setWet(id, wet) { const ch = this.channels.get(id); if (ch) { ch.textureWet = wet; this.apply(id); } }
  removeChannel(id) {
    const ch = this.channels.get(id); if (!ch) return;
    ch.chain.disconnect(); this.channels.delete(id); this.restartIfPlaying();
  }
  update(id, patch) { const ch = this.channels.get(id); if (ch) { Object.assign(ch, patch); this.applyAll(); } }
  setBypass(b) { this.bypass = b; this.applyAll(); this.applyMixEq(); }
  apply(id, immediate = false) {
    const ch = this.channels.get(id); if (!ch) return;
    const anySolo = [...this.channels.values()].some((c) => c.solo);
    const muted = ch.muted || (anySolo && !ch.solo);
    ch.chain.apply(this.bypass ? NEUTRAL : ch.settings, { gainDb: ch.gainDb, muted }, immediate);
    const t = this.ctx.currentTime, w = ch.levels.length && !this.bypass ? ch.textureWet : 0; // Mood off = as recorded
    ch.texDry.gain.setTargetAtTime(1 - w, t, 0.03);
    levelWeights(ch.levels.length, ch.levelPos).forEach((k, i) => ch.levelGains[i].gain.setTargetAtTime(w * k, t, 0.03));
  }
  applyAll() { for (const id of this.channels.keys()) this.apply(id); }

  // ---- Transport ----
  play(from = 0) {
    const dur = this.duration;
    if (!dur) return;
    this.stop();
    const ctx = this.context, g = this.ensureGraph();
    if (ctx.state === 'suspended') ctx.resume();
    from = Math.min(Math.max(0, from), dur - 0.01);
    g.master.gain.cancelScheduledValues(ctx.currentTime); g.master.gain.setValueAtTime(1, ctx.currentTime);
    g.direct.gain.cancelScheduledValues(ctx.currentTime); g.direct.gain.setValueAtTime(1, ctx.currentTime);
    const at = ctx.currentTime + 0.05;
    const start = (buffer, dest) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer; s.loop = this.loop; s.loopEnd = dur;
      s.connect(dest); s.start(at, from); this.srcs.push(s);
      return s;
    };
    if (this.mode === 'stems') {
      for (const ch of this.channels.values()) {
        if (ch.buffer) start(ch.buffer, ch.texDry);
        ch.levels.forEach((b, i) => start(b, ch.levelGains[i]));
      }
    } else if (this.original) start(this.original, g.direct);
    this.t0 = at - from; this.playing = true;
    const first = this.srcs[0];
    if (first && !this.loop) first.onended = () => { if (this.srcs[0] === first) { this.stop(); this.pausedAt = 0; this.onEnded?.(); } };
  }
  restartIfPlaying() { if (this.playing) this.play(this.position); }
  pause() { if (this.playing) { this.pausedAt = this.position; this.stop(); } }
  stop() {
    if (this.srcs.length && this.ctx) {
      const t = this.ctx.currentTime, g = this.graph;
      g.master.gain.setTargetAtTime(0, t, 0.01); g.direct.gain.setTargetAtTime(0, t, 0.01);
      for (const s of this.srcs) { s.onended = null; try { s.stop(t + 0.05); } catch {} }
    }
    this.srcs = []; this.playing = false;
  }
  setLoop(l) { this.loop = l; for (const s of this.srcs) s.loop = l; }
  get position() {
    if (!this.playing || !this.ctx) return this.pausedAt;
    const d = this.duration, p = this.ctx.currentTime - this.t0;
    return this.loop ? ((p % d) + d) % d : Math.min(Math.max(p, 0), d);
  }
  seek(t) { if (this.playing) this.play(t); else this.pausedAt = t; }
}

// Equal-power crossfade weights for a position between levels 0 … n-1.
export function levelWeights(n, pos) {
  const w = Array(n).fill(0);
  if (!n) return w;
  const p = Math.max(0, Math.min(n - 1, pos)), i = Math.min(n - 2, Math.floor(p)), f = p - i;
  if (n === 1) { w[0] = 1; return w; }
  w[i] = Math.cos((f * Math.PI) / 2); w[i + 1] = Math.sin((f * Math.PI) / 2);
  return w;
}
