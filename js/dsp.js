// Per-channel processing chain for the live preview (Web Audio).
// The formulas mirror server/render.py, which renders the final mix with pedalboard. Keep them in sync.
//
//  source → input → EQ (8 bands) → saturation (dry ∥ waveshaper) → compressor → makeup → M/S width → fader ─┬→ bus
//                                                                                                         └→ send → reverb
//  bus (all channels + reverb) → mix EQ (8 bands) → glue compressor → out
//
// The EQ follows Logic / Final Cut's Channel EQ: low cut, low shelf, four bells, high shelf, high cut.
// The mood model drives five of them (its schema bands); the other three are yours.

export const REVERB_SEND = 0.5;
export const dbToGain = (db) => 10 ** (db / 20);
export const compParams = (c) => ({ threshold: -2 - 28 * c, ratio: 1 + 7 * c, attack: 0.01, release: 0.15, makeupDb: 7 * c });
export const NEUTRAL = { eq: [0, 0, 0, 0, 0], comp: 0, sat: 0, reverb: 0, width: 1, level: 0 };

function satCurve(s, n = 2048) {
  const d = 1 + 6 * s, g = 1 + 0.3 * s, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = (Math.tanh(d * x) / d) * g; }
  return c;
}

// Decaying stereo noise, unit energy per channel (render.py builds the same shape).
export function makeReverbIR(ctx, seconds = 2.4, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let e = 0;
    for (let i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); e += d[i] * d[i]; }
    const k = 1 / Math.sqrt(e);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return ir;
}

export function createReverb(ctx, dest) {
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = makeReverbIR(ctx);
  conv.connect(dest);
  return conv;
}

export function createChain(ctx, { out, reverb, analysers = false }) {
  const node = (gain = 1) => { const g = ctx.createGain(); g.gain.value = gain; return g; };
  const eq = createEq(ctx), input = eq.input, last = eq.output; // input is stereo (mono → stereo)

  const dry = node(1), wet = node(0), shaper = ctx.createWaveShaper(), satSum = node();
  shaper.oversample = '2x';
  last.connect(dry); last.connect(shaper); shaper.connect(wet);
  dry.connect(satSum); wet.connect(satSum);

  const comp = ctx.createDynamicsCompressor(), makeup = node();
  comp.knee.value = 6;
  satSum.connect(comp); comp.connect(makeup);

  // Mid/side width: L' = M + w·S, R' = M − w·S
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const lHalf = node(0.5), rHalf = node(0.5), rNeg = node(-0.5), mid = node(), side = node(1), inv = node(-1);
  makeup.connect(split);
  split.connect(lHalf, 0); split.connect(rHalf, 1); split.connect(rNeg, 1);
  lHalf.connect(mid); rHalf.connect(mid); lHalf.connect(side); rNeg.connect(side);
  mid.connect(merge, 0, 0); side.connect(merge, 0, 0);
  mid.connect(merge, 0, 1); side.connect(inv); inv.connect(merge, 0, 1);

  const fader = node(), send = node(0);
  merge.connect(fader); fader.connect(out); fader.connect(send); send.connect(reverb);

  let pre = null, post = null;
  if (analysers) {
    pre = ctx.createAnalyser(); post = ctx.createAnalyser();
    for (const a of [pre, post]) { a.fftSize = 4096; a.smoothingTimeConstant = 0.8; }
    input.connect(pre); fader.connect(post);
  }

  let lastSat = -1;
  function apply(s, { gainDb = 0, muted = false } = {}, immediate = false) {
    const t = ctx.currentTime;
    const set = (p, v) => (immediate ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, 0.05));
    eq.apply(s.bands, immediate);
    const m = Math.min(1, 1.5 * s.sat);
    set(dry.gain, 1 - m); set(wet.gain, m);
    if (Math.abs(s.sat - lastSat) > 0.01) { shaper.curve = satCurve(s.sat); lastSat = s.sat; }
    const cp = compParams(s.comp), on = s.comp > 1e-3;
    set(comp.threshold, on ? cp.threshold : 0); set(comp.ratio, on ? cp.ratio : 1);
    comp.attack.value = cp.attack; comp.release.value = cp.release;
    set(makeup.gain, on ? dbToGain(cp.makeupDb) : 1);
    set(side.gain, s.width);
    const lvl = muted ? 0 : dbToGain(s.level + gainDb);
    set(fader.gain, lvl);
    set(send.gain, s.reverb * REVERB_SEND);
  }
  function disconnect() { try { fader.disconnect(); send.disconnect(); input.disconnect(); } catch {} }
  return { input, apply, disconnect, pre, post };
}

// ---------- the EQ ----------
// A band: { type, on, freq, gain, q, slope }. Cuts are Butterworth cascades (12…48 dB/oct); your Q sets the resonance.
export const EQ_DB = 24, Q_MIN = 0.1, Q_MAX = 12, SLOPES = [12, 24, 36, 48];
const BUTTER = { 12: [0.7071], 24: [0.5412, 1.3066], 36: [0.5176, 0.7071, 1.9319], 48: [0.5098, 0.6013, 0.9, 2.5629] };
const STAGES = { highpass: 4, lowpass: 4 }; // biquads reserved per band (others: 1)
export const isCut = (type) => type === 'highpass' || type === 'lowpass';

// The 8 bands, low to high. `mood` = index of the mood model's schema band that drives this one.
export function eqBands(schema) {
  const m = (i) => ({ type: schema.bands[i].type, label: schema.bands[i].label, freq: schema.bands[i].freq, q: schema.bands[i].q, mood: i, on: true });
  return [
    { type: 'highpass', label: 'Low Cut', freq: 30, q: 0.71, slope: 24, on: false, color: '#ff4d5e' },
    { ...m(0), color: '#ff9f43' },
    { ...m(1), color: '#ffd84d' },
    { ...m(2), color: '#3ddc84' },
    { ...m(3), color: '#2ed3c6' },
    { type: 'peaking', label: 'Bell', freq: 6500, q: 0.71, on: true, color: '#4d8dff' },
    { ...m(4), color: '#a77bff' },
    { type: 'lowpass', label: 'High Cut', freq: 17000, q: 0.71, slope: 12, on: false, color: '#ff5fa2' },
  ];
}

// One band → the biquads that realize it: [{ type, freq, q (linear), gain }]
export function bandBiquads(b) {
  if (!b?.on) return [];
  if (isCut(b.type)) {
    const qs = BUTTER[b.slope] ?? BUTTER[24], k = b.q / 0.71;
    return qs.map((q, i) => ({ type: b.type, freq: b.freq, q: i === qs.length - 1 ? q * k : q, gain: 0 }));
  }
  return [{ type: b.type, freq: b.freq, q: b.q, gain: b.gain || 0 }];
}

// Web Audio's lowpass/highpass take Q in dB; peaking takes it linear; shelves ignore it (slope S = 1).
function setBiquad(f, spec, set) {
  const type = spec?.type ?? 'peaking';
  if (f.type !== type) { f.type = type; set = (p, v) => p.setValueAtTime(v, f.context.currentTime); }
  if (!spec) { set(f.gain, 0); return; } // a peaking filter at 0 dB passes everything unchanged
  set(f.frequency, spec.freq); set(f.gain, spec.gain);
  set(f.Q, isCut(type) ? 20 * Math.log10(spec.q) : spec.q);
}

// An EQ stage (8 bands). apply(bands) with bands = undefined → flat.
export function createEq(ctx, analysers = false) {
  const input = ctx.createGain();
  Object.assign(input, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const types = ['highpass', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass'];
  const slots = types.map((t) => Array.from({ length: STAGES[t] ?? 1 }, () => {
    const f = ctx.createBiquadFilter(); f.type = 'peaking'; f.gain.value = 0; return f;
  }));
  let output = input;
  for (const f of slots.flat()) { output.connect(f); output = f; }
  let pre = null, post = null;
  if (analysers) {
    pre = ctx.createAnalyser(); post = ctx.createAnalyser();
    for (const a of [pre, post]) { a.fftSize = 4096; a.smoothingTimeConstant = 0.8; }
    input.connect(pre); output.connect(post);
  }
  function apply(bands, immediate = false) {
    const t = ctx.currentTime;
    const set = (p, v) => (immediate ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, 0.03));
    slots.forEach((fs, i) => { const specs = bandBiquads(bands?.[i]); fs.forEach((f, k) => setBiquad(f, specs[k], set)); });
  }
  return { input, output, apply, pre, post };
}

// Magnitude response (dB) of a set of bands (or one band) at the given frequencies.
let probe = null;
export function eqResponse(bands, freqs) {
  probe ??= new OfflineAudioContext(1, 1, 44100).createBiquadFilter();
  const total = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  for (const b of bands || []) for (const s of bandBiquads(b)) {
    probe.type = s.type; probe.frequency.value = s.freq; probe.gain.value = s.gain;
    probe.Q.value = isCut(s.type) ? 20 * Math.log10(s.q) : s.q;
    probe.getFrequencyResponse(freqs, mag, ph);
    for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k] + 1e-12);
  }
  return total;
}
