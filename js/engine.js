// Playback + offline render. Base track and generated instruments share one beat grid.
import { playDrum, playNote, makeReverbIR } from './instruments.js';
import { eventsForStep } from './arranger.js';

const LOOKAHEAD = 0.12, TICK_MS = 25;
const BASE_GAIN = { drums: 0.8, violin: 0.32, trumpet: 0.26, piano: 0.4, guitar: 0.35, bass: 0.55 };
const SEND = { R: 0.12, G: 0.25, B: 0.5 };

const irCache = new WeakMap();
function buildGraph(ctx, { compress = true } = {}) {
  const master = ctx.createGain();
  let comp = master;
  if (compress) {
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
    master.connect(comp);
  }
  comp.connect(ctx.destination);
  const reverb = ctx.createConvolver();
  if (!irCache.has(ctx)) irCache.set(ctx, makeReverbIR(ctx));
  reverb.buffer = irCache.get(ctx);
  reverb.connect(master);
  const base = ctx.createGain();
  base.connect(master);
  const tracks = {};
  for (const id of Object.keys(BASE_GAIN)) {
    const gain = ctx.createGain(), send = ctx.createGain();
    gain.gain.value = 0; send.gain.value = 0;
    gain.connect(master); gain.connect(send); send.connect(reverb);
    tracks[id] = { gain, send };
  }
  return { master, comp, base, tracks };
}

function applyMix(graph, cfg, ctx, immediate) {
  const t = ctx.currentTime;
  const set = (p, v) => (immediate ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, 0.04));
  set(graph.base.gain, cfg.baseVol);
  for (const [id, node] of Object.entries(graph.tracks)) {
    const tr = cfg.tracks.find((x) => x.id === id);
    set(node.gain.gain, tr ? BASE_GAIN[id] * Math.pow(tr.level, 1.2) : 0);
    set(node.send.gain, tr ? SEND[tr.channel] * (cfg.mood?.reverb ?? 1) : 0);
  }
}

function scheduleStep(ctx, graph, A, cfg, s, when) {
  for (const tr of cfg.tracks) {
    const out = graph.tracks[tr.id].gain;
    for (const ev of eventsForStep(s, A, tr, cfg.mood)) {
      if (ev.type === 'drum') playDrum(ctx, out, ev.drum, when, ev.vel);
      else ev.notes.forEach((m, i) => playNote(ctx, out, tr.id, m, when + i * (ev.strum || 0), ev.dur, ev.vel, ev));
    }
  }
}

export class Engine {
  constructor() {
    this.ctx = null; this.buffer = null; this.A = null;
    this.cfg = { tracks: [], mood: null, baseVol: 0.8, loop: true };
    this.playing = false; this.pausedAt = 0; this.srcs = []; this.graph = null; this.timer = null;
    this.onEnded = null;
  }
  get context() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Tap on the final output, used to drive the visuals (orb + live waveform)
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
    }
    return this.ctx;
  }
  load(buffer, A) { this.stop(); this.buffer = buffer; this.A = A; this.pausedAt = 0; }
  setConfig(c) {
    Object.assign(this.cfg, c);
    if (this.graph && this.playing) applyMix(this.graph, this.cfg, this.ctx, false);
  }
  play(from = 0) {
    if (!this.buffer) return;
    this.stop();
    const ctx = this.context;
    if (ctx.state === 'suspended') ctx.resume();
    from = Math.min(Math.max(0, from), this.buffer.duration - 0.01);
    this.graph = buildGraph(ctx);
    this.graph.comp.connect(this.analyser);
    applyMix(this.graph, this.cfg, ctx, true);
    this.playing = true;
    this.startSegment(ctx.currentTime + 0.06, from);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }
  startSegment(at, from) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.graph.base);
    src.start(at, from);
    this.srcs = this.srcs.slice(-1).concat(src);
    this.t0 = at - from;
    this.segEnd = this.t0 + this.buffer.duration;
    const st = this.A.stepTimes;
    let s = 0;
    while (s < st.length && st[s] < from - 1e-3) s++;
    this.nextStep = s;
  }
  tick() {
    const ctx = this.ctx, A = this.A, horizon = ctx.currentTime + LOOKAHEAD;
    while (this.nextStep < A.stepTimes.length) {
      const when = this.t0 + A.stepTimes[this.nextStep];
      if (when > horizon) break;
      if (when > ctx.currentTime - 0.02) scheduleStep(ctx, this.graph, A, this.cfg, this.nextStep, Math.max(when, ctx.currentTime));
      this.nextStep++;
    }
    if (this.nextStep >= A.stepTimes.length) {
      if (this.cfg.loop) {
        if (this.segEnd - ctx.currentTime < LOOKAHEAD) this.startSegment(this.segEnd, 0);
      } else if (ctx.currentTime >= this.segEnd) {
        this.stop(); this.pausedAt = 0; this.onEnded?.();
      }
    }
  }
  pause() { if (this.playing) { this.pausedAt = this.position; this.stop(); } }
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.graph) {
      const g = this.graph, ctx = this.ctx;
      g.master.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      for (const s of this.srcs) try { s.stop(ctx.currentTime + 0.08); } catch {}
      setTimeout(() => { try { g.comp.disconnect(); } catch {} }, 250);
    }
    this.srcs = []; this.graph = null; this.playing = false;
  }
  get position() {
    if (!this.playing || !this.ctx) return this.pausedAt;
    const d = this.buffer.duration;
    let p = this.ctx.currentTime - this.t0;
    if (p < 0) p += d;
    return Math.min(Math.max(p, 0), d);
  }
  seek(t) { if (this.playing) this.play(t); else this.pausedAt = t; }

  async render() {
    const sr = this.buffer.sampleRate;
    const ctx = new OfflineAudioContext(2, this.buffer.length + Math.round(sr * 2), sr);
    const graph = buildGraph(ctx);
    applyMix(graph, this.cfg, ctx, true);
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.connect(graph.base); src.start(0);
    this.A.stepTimes.forEach((t, s) => scheduleStep(ctx, graph, this.A, this.cfg, s, t));
    return ctx.startRendering();
  }

  // ---- Visualization renders (mono, low sample rate, no master compressor) ----
  async renderBaseMono(sr) {
    const ctx = new OfflineAudioContext(1, Math.ceil(this.buffer.duration * sr), sr);
    const src = ctx.createBufferSource();
    src.buffer = this.buffer; src.connect(ctx.destination); src.start(0);
    return (await ctx.startRendering()).getChannelData(0);
  }
  // One instrument alone, exactly as it sits in the mix (gain + reverb), without the base track.
  async renderStem(track, mood, sr) {
    const ctx = new OfflineAudioContext(1, Math.ceil(this.buffer.duration * sr), sr);
    const graph = buildGraph(ctx, { compress: false });
    const cfg = { tracks: [track], mood, baseVol: 0 };
    applyMix(graph, cfg, ctx, true);
    this.A.stepTimes.forEach((t, s) => scheduleStep(ctx, graph, this.A, cfg, s, t));
    return (await ctx.startRendering()).getChannelData(0);
  }
}
