// Web Audio synth instruments (no samples needed).
// PLUGIN POINT: replace with sampled instruments / soundfonts / neural timbre models.

export const INSTRUMENT_LIST = [
  { id: 'drums', name: 'Drums', icon: '🥁', blurb: 'kick · snare · hats' },
  { id: 'violin', name: 'Violin', icon: '🎻', blurb: 'bowed strings' },
  { id: 'trumpet', name: 'Trumpet', icon: '🎺', blurb: 'bright brass' },
  { id: 'piano', name: 'Piano', icon: '🎹', blurb: 'keys & chords' },
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const noiseBuffers = new WeakMap();
function noise(ctx) {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

export function makeReverbIR(ctx, seconds = 2.4, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

// Exponential percussive envelope into `out`; returns the gain node to connect sources to.
function perc(ctx, out, t, peak, decay, attack = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function filtered(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  return f;
}

export function playDrum(ctx, out, kind, t, vel = 1) {
  const end = (d) => t + d + 0.05;
  switch (kind) {
    case 'kick': {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      o.connect(perc(ctx, out, t, 1.0 * vel, 0.4, 0.004));
      o.start(t); o.stop(end(0.4));
      break;
    }
    case 'snare': {
      const n = noise(ctx), hp = filtered(ctx, 'highpass', 1200);
      n.connect(hp).connect(perc(ctx, out, t, 0.55 * vel, 0.18));
      n.start(t, Math.random()); n.stop(end(0.18));
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 185;
      o.connect(perc(ctx, out, t, 0.4 * vel, 0.1));
      o.start(t); o.stop(end(0.1));
      break;
    }
    case 'rim': {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 820;
      o.connect(perc(ctx, out, t, 0.35 * vel, 0.035));
      o.start(t); o.stop(end(0.04));
      const n = noise(ctx), bp = filtered(ctx, 'bandpass', 3000, 2);
      n.connect(bp).connect(perc(ctx, out, t, 0.4 * vel, 0.03));
      n.start(t, Math.random()); n.stop(end(0.03));
      break;
    }
    case 'hat':
    case 'openhat': {
      const d = kind === 'hat' ? 0.045 : 0.28;
      const n = noise(ctx), hp = filtered(ctx, 'highpass', 7500);
      n.connect(hp).connect(perc(ctx, out, t, 0.3 * vel, d));
      n.start(t, Math.random()); n.stop(end(d));
      break;
    }
    case 'shaker': {
      const n = noise(ctx), bp = filtered(ctx, 'bandpass', 5500, 0.8);
      n.connect(bp).connect(perc(ctx, out, t, 0.22 * vel, 0.07, 0.015));
      n.start(t, Math.random()); n.stop(end(0.09));
      break;
    }
    case 'tom': {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.25);
      o.connect(perc(ctx, out, t, 0.7 * vel, 0.3, 0.003));
      o.start(t); o.stop(end(0.3));
      break;
    }
  }
}

// env -> rel -> out. `env` shapes attack/decay, `rel` handles note-off release.
function voiceOut(ctx, out, t, dur, release) {
  const env = ctx.createGain(), rel = ctx.createGain();
  env.connect(rel).connect(out);
  rel.gain.setValueAtTime(1, t);
  rel.gain.setTargetAtTime(0, t + dur, release);
  return { env, end: t + dur + release * 6 };
}

export function playNote(ctx, out, inst, midi, t, dur, vel = 0.8, opts = {}) {
  const f = mtof(midi), tone = opts.tone ?? 1;
  if (inst === 'piano') piano(ctx, out, f, t, dur, vel, tone);
  else if (inst === 'violin') violin(ctx, out, f, t, dur, vel, tone, opts.legato);
  else if (inst === 'trumpet') trumpet(ctx, out, f, t, dur, vel, tone, opts.muted);
}

function piano(ctx, out, f, t, dur, vel, tone) {
  const { env, end } = voiceOut(ctx, out, t, dur, 0.12);
  const lp = filtered(ctx, 'lowpass', 1000, 0.5);
  lp.frequency.setValueAtTime(Math.min(15000, f * (5 + 6 * vel) * tone + 600), t);
  lp.frequency.setTargetAtTime(Math.max(300, f * 2 * tone), t, 0.5);
  lp.connect(env);
  const peak = 0.25 * vel;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  env.gain.setTargetAtTime(0.0001, t + 0.005, clamp(0.2 + 180 / f, 0.25, 1.6));
  for (const [mult, type, amp, det] of [[1, 'triangle', 1, -4], [1, 'triangle', 0.6, 4], [2, 'sine', 0.25, 0], [3, 'sine', 0.08, 1]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f * mult; o.detune.value = det; g.gain.value = amp;
    o.connect(g).connect(lp);
    o.start(t); o.stop(end);
  }
}

function violin(ctx, out, f, t, dur, vel, tone, legato) {
  const short = dur < 0.25;
  const { env, end } = voiceOut(ctx, out, t, dur, short ? 0.03 : 0.14);
  const hp = filtered(ctx, 'highpass', 220);
  const lp = filtered(ctx, 'lowpass', Math.min(14000, (2200 + f * 1.5) * tone), 0.8);
  const body = ctx.createBiquadFilter();
  body.type = 'peaking'; body.frequency.value = 2800; body.Q.value = 1.2; body.gain.value = 4;
  hp.connect(lp).connect(body).connect(env);
  const peak = 0.2 * vel, atk = short ? 0.01 : legato ? 0.12 : 0.06;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + atk);
  env.gain.setTargetAtTime(short ? 0.0001 : peak * 0.8, t + atk, short ? 0.08 : 0.3);
  const lfo = ctx.createOscillator(), depth = ctx.createGain();
  lfo.frequency.value = 5.4 + Math.random() * 0.6;
  depth.gain.setValueAtTime(0, t);
  if (!short) { depth.gain.setValueAtTime(0, t + 0.18); depth.gain.linearRampToValueAtTime(14, t + 0.6); }
  lfo.connect(depth);
  for (const det of [-6, 5]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
    depth.connect(o.detune);
    o.connect(hp);
    o.start(t); o.stop(end);
  }
  lfo.start(t); lfo.stop(end);
}

function trumpet(ctx, out, f, t, dur, vel, tone, muted) {
  const { env, end } = voiceOut(ctx, out, t, dur, 0.06);
  const lp = filtered(ctx, 'lowpass', f, 2);
  const top = Math.min(12000, f * (muted ? 2.2 : 3 + 5 * vel) * tone);
  lp.frequency.setValueAtTime(f * 1.1, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.2, top), t + 0.05);
  lp.frequency.setTargetAtTime(Math.max(f * 1.1, top * 0.6), t + 0.05, 0.25);
  lp.connect(env);
  const peak = 0.22 * vel;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(peak, t + 0.03);
  env.gain.setTargetAtTime(peak * 0.75, t + 0.03, 0.15);
  for (const [type, amp] of [['sawtooth', 1], ['square', 0.35]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = amp;
    o.detune.setValueAtTime(-40, t);
    o.detune.linearRampToValueAtTime(0, t + 0.06);
    o.connect(g).connect(lp);
    o.start(t); o.stop(end);
  }
}

// Simple bass used by the demo beat.
export function playBass(ctx, out, midi, t, dur, vel = 0.8) {
  const f = mtof(midi);
  const { env, end } = voiceOut(ctx, out, t, dur, 0.05);
  const lp = filtered(ctx, 'lowpass', 500, 4);
  lp.frequency.setValueAtTime(1400, t);
  lp.frequency.setTargetAtTime(350, t, 0.08);
  lp.connect(env);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.006);
  env.gain.setTargetAtTime(0.25 * vel, t + 0.006, 0.2);
  const o = ctx.createOscillator();
  o.type = 'sawtooth'; o.frequency.value = f;
  o.connect(lp);
  o.start(t); o.stop(end);
}
