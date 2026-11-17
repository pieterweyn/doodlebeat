// Lightweight in-browser music analysis: beats (DP beat tracker), key, per-bar chords,
// per-beat melody pitch-class & energy, per-16th onset strength.
// PLUGIN POINT: swap this for a backend analyzer (librosa / madmom / basic-pitch) that
// returns the same shape.

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
const mod12 = (n) => ((n % 12) + 12) % 12;
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function analyzeBuffer(buffer, onProgress = () => {}) {
  const { x, sr } = downmix(buffer);
  const N = 2048, hop = 512, half = N / 2, fr = sr / hop;
  const frameTime = (f) => (f * hop + N / 2) / sr;
  const nFrames = Math.max(1, Math.floor((x.length - N) / hop) + 1);

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const cosT = new Float32Array(half), sinT = new Float32Array(half);
  for (let i = 0; i < half; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = Math.sin((2 * Math.PI * i) / N); }
  const binPc = new Int8Array(half).fill(-1);
  for (let k = 1; k < half; k++) {
    const f = (k * sr) / N;
    if (f >= 80 && f <= 5000) binPc[k] = mod12(Math.round(69 + 12 * Math.log2(f / 440)));
  }

  const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(half);
  const flux = new Float32Array(nFrames), rms = new Float32Array(nFrames), chroma = new Float32Array(nFrames * 12);

  for (let i = 0; i < nFrames; i++) {
    const o = i * hop;
    let e = 0;
    for (let n = 0; n < N; n++) { const v = o + n < x.length ? x[o + n] : 0; e += v * v; re[n] = v * win[n]; im[n] = 0; }
    rms[i] = Math.sqrt(e / N);
    fft(re, im, cosT, sinT);
    let fl = 0;
    for (let k = 1; k < half; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const lg = Math.log1p(10 * mag);
      const d = lg - prev[k];
      if (d > 0) fl += d;
      prev[k] = lg;
      const pc = binPc[k];
      if (pc >= 0) chroma[i * 12 + pc] += mag;
    }
    flux[i] = i === 0 ? 0 : fl;
    if ((i & 1023) === 0) { onProgress((0.85 * i) / nFrames); await yieldUI(); }
  }

  // Onset envelope: detrended, rectified, normalized 0..1
  const env = detrend(flux, Math.round(fr * 0.3));
  const p98 = percentile(env, 0.98) || 1;
  for (let i = 0; i < env.length; i++) env[i] = Math.min(1, env[i] / p98);

  // Beats
  let beats = [];
  const rmsMax = Math.max(...sample(rms)) || 1;
  if (rmsMax > 1e-4) {
    const period = estimatePeriod(env, fr);
    beats = trackBeats(env, period);
    const loud = (f) => { let m = 0; for (let j = f; j < Math.min(rms.length, f + period); j++) m = Math.max(m, rms[j]); return m > 0.03 * rmsMax; };
    while (beats.length > 4 && !loud(beats[0])) beats.shift();
    while (beats.length > 4 && !loud(beats[beats.length - 1])) beats.pop();
  }
  let beatTimes;
  if (beats.length >= 4) beatTimes = beats.map(frameTime);
  else { beatTimes = []; for (let t = 0; t < buffer.duration; t += 0.6) beatTimes.push(t); beats = beatTimes.map((t) => Math.round((t * sr - N / 2) / hop)); }
  const nBeats = beatTimes.length;
  const beatDur = beatTimes.map((t, b) => (b < nBeats - 1 ? beatTimes[b + 1] - t : beatTimes[b] - beatTimes[b - 1] || 0.6));
  const bpm = Math.round((60 * (nBeats - 1)) / (beatTimes[nBeats - 1] - beatTimes[0]));

  // Per-beat chroma & energy
  const beatChroma = new Float32Array(nBeats * 12);
  const beatEnergyRaw = new Float32Array(nBeats);
  for (let b = 0; b < nBeats; b++) {
    const f0 = Math.max(0, beats[b]);
    const f1 = Math.min(nFrames, b < nBeats - 1 ? beats[b + 1] : f0 + Math.round(beatDur[b] * fr));
    let e = 0, c = 0;
    for (let f = f0; f < f1; f++) { e += rms[f]; c++; for (let p = 0; p < 12; p++) beatChroma[b * 12 + p] += chroma[f * 12 + p]; }
    beatEnergyRaw[b] = c ? e / c : 0;
  }
  const eNorm = percentile(beatEnergyRaw, 0.95) || 1;
  const beatEnergy = Array.from(beatEnergyRaw, (v) => Math.min(1, v / eNorm));

  // Downbeat: which beat phase (mod 4) carries most onset+energy
  const phaseScore = [0, 0, 0, 0];
  for (let b = 0; b < nBeats; b++) phaseScore[b % 4] += (env[Math.max(0, beats[b])] || 0) + beatEnergy[b];
  const d = phaseScore.indexOf(Math.max(...phaseScore));
  const barShift = (4 - d) % 4;

  // Key (Krumhansl–Schmuckler)
  const global = new Array(12).fill(0);
  for (let b = 0; b < nBeats; b++) for (let p = 0; p < 12; p++) global[p] += beatChroma[b * 12 + p];
  let best = -Infinity, key = { root: 0, mode: 'major' };
  for (let r = 0; r < 12; r++) {
    const rot = global.map((_, i) => global[(i + r) % 12]);
    const cM = corr(rot, MAJOR_PROFILE), cm = corr(rot, MINOR_PROFILE);
    if (cM > best) { best = cM; key = { root: r, mode: 'major' }; }
    if (cm > best) { best = cm; key = { root: r, mode: 'minor' }; }
  }
  const scalePcs = (key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE).map((i) => (key.root + i) % 12);
  key.name = `${PC_NAMES[key.root]} ${key.mode}`;

  // Diatonic triads, chord per bar
  const triads = [0, 1, 2, 3, 4, 5, 6].map((deg) => {
    const pcs = [scalePcs[deg], scalePcs[(deg + 2) % 7], scalePcs[(deg + 4) % 7]];
    const third = mod12(pcs[1] - pcs[0]), fifth = mod12(pcs[2] - pcs[0]);
    const quality = fifth === 6 ? 'dim' : third === 4 ? 'maj' : 'min';
    return { degree: deg, root: pcs[0], pcs, quality, name: PC_NAMES[pcs[0]] + (quality === 'min' ? 'm' : quality === 'dim' ? '°' : '') };
  });
  const nBars = Math.floor((nBeats - 1 + barShift) / 4) + 1;
  const chords = [];
  for (let bar = 0; bar < nBars; bar++) {
    const c = new Array(12).fill(0);
    for (let b = bar * 4 - barShift; b < bar * 4 - barShift + 4; b++) if (b >= 0 && b < nBeats) for (let p = 0; p < 12; p++) c[p] += beatChroma[b * 12 + p];
    const norm = Math.hypot(...c);
    if (norm < 1e-6) { chords.push(chords[bar - 1] || triads[0]); continue; }
    for (let p = 0; p < 12; p++) c[p] /= norm;
    let bs = -Infinity, bt = triads[0];
    for (const t of triads) {
      let s = c[t.pcs[0]] + 0.8 * c[t.pcs[1]] + 0.8 * c[t.pcs[2]];
      for (let p = 0; p < 12; p++) if (!t.pcs.includes(p)) s -= 0.15 * c[p];
      if (t.degree === 0) s += 0.04;
      if (t.degree === 3 || t.degree === 4) s += 0.02;
      if (t.quality === 'dim') s -= 0.08;
      if (s > bs) { bs = s; bt = t; }
    }
    chords.push(bt);
  }

  // Per-beat melody pitch class (strongest in-scale pc)
  const beatMelody = [];
  for (let b = 0; b < nBeats; b++) {
    let bp = -1, bv = 0;
    for (const p of scalePcs) if (beatChroma[b * 12 + p] > bv) { bv = beatChroma[b * 12 + p]; bp = p; }
    const bar = Math.floor((b + barShift) / 4);
    beatMelody.push(bp >= 0 ? bp : chords[Math.min(bar, nBars - 1)].root);
  }

  // 16th-note grid + onset strength
  const stepTimes = [], stepOnset = [];
  for (let b = 0; b < nBeats; b++) {
    for (let s = 0; s < 4; s++) {
      const t = beatTimes[b] + (s * beatDur[b]) / 4;
      if (t >= buffer.duration - 0.05) break;
      const f = Math.round((t * sr - N / 2) / hop);
      let m = 0;
      for (let j = f - 1; j <= f + 1; j++) if (j >= 0 && j < env.length) m = Math.max(m, env[j]);
      stepTimes.push(t);
      stepOnset.push(m);
    }
  }
  onProgress(1);

  return { duration: buffer.duration, bpm, beatTimes, beatDur, barShift, nBars, chords, key, scalePcs, beatMelody, beatEnergy, stepTimes, stepOnset };
}

function downmix(buffer) {
  const sr0 = buffer.sampleRate;
  const factor = sr0 >= 32000 ? Math.round(sr0 / 22050) : 1;
  const len = Math.floor(buffer.length / factor);
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  const x = new Float32Array(len), k = factor * chs.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const ch of chs) for (let j = 0; j < factor; j++) s += ch[i * factor + j];
    x[i] = s / k;
  }
  return { x, sr: sr0 / factor };
}

function fft(re, im, cosT, sinT) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const wr = cosT[k * step], wi = -sinT[k * step];
        const a = i + k, b = a + h;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

function detrend(x, w) {
  const n = x.length, pre = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    out[i] = Math.max(0, x[i] - (pre[b] - pre[a]) / (b - a));
  }
  return out;
}

function acf(env, lag) {
  const n = env.length, li = Math.floor(lag), f = lag - li;
  let s = 0;
  for (let i = 0; i + li + 1 < n; i++) s += env[i] * (env[i + li] * (1 - f) + env[i + li + 1] * f);
  return s / Math.max(1, n - li);
}

function estimatePeriod(env, fr) {
  const minP = (fr * 60) / 180, maxP = (fr * 60) / 60;
  let best = -Infinity, bestP = (fr * 60) / 100;
  for (let p = minP; p <= maxP; p += 0.1) {
    const bpm = (60 * fr) / p;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    const sc = (acf(env, p) + 0.5 * acf(env, 2 * p)) * w;
    if (sc > best) { best = sc; bestP = p; }
  }
  return bestP;
}

// Ellis (2007) dynamic-programming beat tracker
function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += env[i] * env[i];
  const std = Math.sqrt(ss / n) || 1;
  const cum = new Float32Array(n), back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bj = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d;
      if (j < 0) break;
      const sc = cum[j] - tightness * Math.log(d / period) ** 2;
      if (sc > best) { best = sc; bj = j; }
    }
    const local = env[i] / std;
    if (bj < 0 || best < 0) cum[i] = local;
    else { cum[i] = local + best; back[i] = bj; }
  }
  let last = n - 1, bv = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (cum[i] > bv) { bv = cum[i]; last = i; }
  const beats = [];
  for (let i = last; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

function percentile(arr, q) {
  const s = Array.from(sample(arr)).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function sample(arr, max = 20000) {
  if (arr.length <= max) return arr;
  const out = new Float32Array(max), step = arr.length / max;
  for (let i = 0; i < max; i++) out[i] = arr[Math.floor(i * step)];
  return out;
}
function corr(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / (Math.sqrt(da * db) || 1);
}
