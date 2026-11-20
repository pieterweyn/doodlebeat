// Per-channel processing chain for the live preview (Web Audio).
// The formulas mirror server/render.py, which renders the final mix with pedalboard. Keep them in sync.
//
//  source → input → EQ ×5 → saturation (dry ∥ waveshaper) → compressor → makeup → M/S width → fader ─┬→ bus
//                                                                                                  └→ send → reverb

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

export function createChain(ctx, schema, { out, reverb, analysers = false }) {
  const node = (gain = 1) => { const g = ctx.createGain(); g.gain.value = gain; return g; };
  const input = node();
  Object.assign(input, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' }); // mono → stereo

  const bands = schema.bands.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; f.gain.value = 0;
    return f;
  });
  let last = input;
  for (const f of bands) { last.connect(f); last = f; }

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
    s.eq.forEach((g, i) => set(bands[i].gain, g));
    if (s.freqs) s.freqs.forEach((f, i) => set(bands[i].frequency, f));
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

// EQ magnitude response (dB) of a settings vector at the given frequencies.
let probe = null;
export function eqResponse(schema, eq, freqs, bandFreqs = null) {
  if (!probe) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    probe = schema.bands.map((b) => { const f = ctx.createBiquadFilter(); f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; return f; });
  }
  const total = new Float32Array(freqs.length), mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
  probe.forEach((f, i) => {
    f.gain.value = eq[i] || 0;
    f.frequency.value = bandFreqs?.[i] ?? schema.bands[i].freq;
    f.getFrequencyResponse(freqs, mag, ph);
    for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(mag[k] + 1e-12);
  });
  return total;
}
