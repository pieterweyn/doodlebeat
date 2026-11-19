// Rule-based arranger: for each 16th-note step of the base song, decide what each
// selected instrument plays, given its color role (R/G/B), intensity, and the global mood.
// PLUGIN POINT: replace eventsForStep with an AI generator (symbolic model / MusicGen etc.).

const REG = {
  piano: { R: [60, 84], G: [55, 79], B: [40, 64] },
  violin: { R: [67, 91], G: [62, 86], B: [55, 74] },
  trumpet: { R: [62, 82], G: [58, 79], B: [52, 70] },
  guitar: { R: [40, 64], G: [52, 79], B: [45, 69] },
  bass: { R: [33, 52], G: [31, 55], B: [28, 45] },
};
const SEED = { drums: 11, violin: 23, trumpet: 37, piano: 53, guitar: 67, bass: 79 };
const mod12 = (n) => ((n % 12) + 12) % 12;

function hash(a, b) {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function chordPcs(chord, ext, scale) {
  const at = (k) => scale[(chord.degree + k) % 7];
  const pcs = [at(0), at(2), at(4)];
  if (ext === '7' || ext === '79') pcs.push(at(6));
  if (ext === 'add9' || ext === '79') pcs.push(at(1));
  if (ext === '6') pcs.push(at(5));
  return pcs;
}

function voice(pcs, lo, hi) {
  const out = [];
  let m = lo;
  for (const pc of pcs) { while (mod12(m) !== pc) m++; out.push(m); m++; }
  return out.filter((n, i) => i < 2 || n <= hi);
}

function nearestPc(pc, center) {
  const c = Math.round(center);
  for (let d = 0; d <= 6; d++) { if (mod12(c + d) === pc) return c + d; if (mod12(c - d) === pc) return c - d; }
  return c;
}

function stepToward(from, to, scale) {
  const dir = to === from ? 1 : Math.sign(to - from);
  let m = from + dir;
  while (!scale.includes(mod12(m))) m += dir;
  return m;
}

export function eventsForStep(s, A, track, mood) {
  const L = track.level;
  if (L < 0.02 || !mood) return [];
  const b = Math.floor(s / 4), sub = s % 4;
  const c = {
    A, mood, L, sub, b,
    ch: track.channel,
    pos: (b + A.barShift) % 4,
    bar: Math.floor((b + A.barShift) / 4),
    onset: A.stepOnset[s] ?? 0,
    beatDur: A.beatDur[b] ?? 0.5,
    r: hash(s, SEED[track.id]),
  };
  const dyn = 0.55 + 0.45 * (A.beatEnergy[b] ?? 0.5);
  return track.id === 'drums' ? drums(c, dyn) : pitched(track.id, c, dyn);
}

function drums({ ch, pos, sub, L, onset, r, bar }, dyn) {
  const out = [];
  const hit = (drum, vel) => out.push({ type: 'drum', drum, vel: vel * dyn });
  const back = sub === 0 && (pos === 1 || pos === 3);
  const down = sub === 0 && (pos === 0 || pos === 2);
  if (ch === 'R') {
    if (L > 0.85 && bar % 4 === 3 && pos === 3) { hit(sub < 2 ? 'tom' : 'snare', 0.7 + 0.1 * sub); return out; }
    if (down) hit('kick', 1);
    else if (L > 0.5 && onset > 0.65 && !back) hit('kick', 0.8);
    if (back) hit('snare', 0.95);
    else if (L > 0.7 && sub === 3 && r < 0.3) hit('snare', 0.3);
    if (sub % 2 === 0) hit('hat', sub === 0 ? 0.75 : 0.55);
    else if (L > 0.55) hit('hat', 0.35);
    if (L > 0.75 && pos === 3 && sub === 2) hit('openhat', 0.6);
  } else if (ch === 'G') {
    if (down) hit('kick', 0.9);
    if (L > 0.6 && pos === 1 && sub === 2) hit('kick', 0.6);
    if (back) hit('rim', 0.8);
    if (L > 0.35 || sub % 2 === 0) hit('shaker', sub % 2 === 0 ? 0.8 : 0.5);
    if (L > 0.7 && sub === 2) hit('hat', 0.35);
  } else {
    if (pos === 0 && sub === 0) hit('kick', 0.85);
    if (L > 0.5 && pos === 2 && sub === 2) hit('kick', 0.6);
    if (pos === 2 && sub === 0) hit('rim', 0.7);
    if (L > 0.35 && sub === 0) hit('hat', 0.3);
    if (L > 0.7 && sub === 2) hit('hat', 0.2);
  }
  return out;
}

function pitched(id, { A, mood, ch, pos, sub, b, bar, L, onset, r, beatDur }, dyn) {
  const out = [];
  const chord = A.chords[Math.max(0, Math.min(bar, A.chords.length - 1))];
  const pcs = chordPcs(chord, mood.extension, A.scalePcs);
  const [lo, hi] = REG[id][ch];
  const tone = mood.tone * (ch === 'R' ? 1.25 : ch === 'B' ? 0.75 : 1);
  const vel = dyn * (0.55 + 0.45 * L);
  const note = (notes, beats, v = 1, extra = {}) =>
    out.push({ type: 'note', notes: [].concat(notes), dur: beats * beatDur, vel: vel * v, tone, ...extra });

  if (id === 'bass') {
    const root = nearestPc(chord.root, lo + 6);
    const fifth = nearestPc(pcs[2], root + 7), third = nearestPc(pcs[1], root + 4);
    if (ch === 'R') {
      if (sub % 2 === 0) note(L > 0.6 && sub === 2 && pos % 2 ? root + 12 : root, 0.45, sub === 0 ? 1 : 0.8);
      else if (L > 0.7 && onset > 0.6) note(root, 0.2, 0.7);
    } else if (ch === 'G') {
      const nextChord = A.chords[Math.min(bar + 1, A.chords.length - 1)];
      const nextRoot = nearestPc(nextChord.root, root);
      const walk = [root, L > 0.5 ? third : root, fifth, stepToward(nextRoot, root, A.scalePcs)];
      if (sub === 0) note(walk[pos], 0.9, pos === 0 ? 1 : 0.85);
      else if (L > 0.6 && sub === 2 && hash(b, 91) < 0.5) note(stepToward(walk[pos], walk[(pos + 1) % 4], A.scalePcs), 0.4, 0.6);
    } else {
      if (pos === 0 && sub === 0) note(root, 3.9, 0.9);
      else if (L > 0.5 && pos === 2 && sub === 0) note(fifth, 1.9, 0.7);
    }
    return out;
  }

  if (id === 'guitar') {
    if (ch === 'R') {
      const root = nearestPc(chord.root, lo + 6);
      const power = [root, root + 7, root + 12];
      if (sub === 0 || (L > 0.45 && sub === 2) || (L > 0.75 && onset > 0.5)) note(power, sub === 0 ? 0.4 : 0.2, sub === 0 ? 1 : 0.7, { drive: true, strum: 0.006 });
    } else if (ch === 'G') {
      const tones = voice(pcs, lo, hi);
      const order = [0, 2, 1, 3, 2, 1];
      const rate = L > 0.65 ? 1 : 2;
      if (sub % rate === 0) note(tones[order[Math.floor((pos * 4 + sub) / rate) % order.length] % tones.length], 0.6, 0.85);
    } else {
      const strum = voice([...pcs.slice(0, 3), pcs[0]], lo, hi);
      if (pos === 0 && sub === 0) note(strum, 3.9, 0.9, { strum: 0.03 });
      else if (L > 0.55 && pos === 2 && sub === 0) note(strum.slice(1).reverse(), 1.9, 0.5, { strum: 0.02 });
    }
    return out;
  }

  if (ch === 'R') {
    const tones = voice(pcs, lo, hi);
    if (id === 'piano') {
      const stab = tones.slice(0, 4);
      if (sub === 2) note(stab, 0.3, 0.9);
      else if (L > 0.5 && sub === 0 && pos === 0) note(stab, 0.3);
      else if (L > 0.75 && sub % 2 === 1 && onset > 0.55) note(stab, 0.2, 0.7);
    } else if (id === 'violin') {
      if (sub % 2 === 0 || L > 0.65) {
        const order = [0, 2, 1, 3, 2, 1, 0, 1];
        note(tones[order[(pos * 4 + sub) % 8] % tones.length], 0.22, sub === 0 ? 1 : 0.75);
      }
    } else {
      const top = tones[tones.length - 1];
      if (sub === 2 && (pos === 1 || pos === 3)) note(top, 0.35);
      else if (L > 0.4 && pos === 0 && sub === 0) note(top, 0.5, 0.9);
      else if (L > 0.7 && onset > 0.7 && sub !== 0) note(tones[Math.floor(r * tones.length)], 0.2, 0.8);
    }
  } else if (ch === 'G') {
    if (id === 'piano') {
      const base = voice(pcs, lo, hi);
      const up = base.concat(base.map((m) => m + 12));
      const seq = up.concat(up.slice(1, -1).reverse());
      const rate = L > 0.6 ? 1 : 2;
      if (sub % rate === 0) note(seq[Math.floor((pos * 4 + sub) / rate) % seq.length], rate === 1 ? 0.5 : 0.9, 0.85);
    } else {
      const m = nearestPc(A.beatMelody[b] ?? chord.root, (lo + hi) / 2);
      const sparse = id === 'trumpet' && L < 0.45;
      const passing = L > 0.6 && hash(b, SEED[id] * 7) < 0.7;
      if (sub === 0 && (!sparse || pos % 2 === 0)) note(m, sparse ? 1.9 : passing ? 0.5 : 0.95, 1, { legato: true });
      else if (passing && sub === 2) {
        const next = nearestPc(A.beatMelody[b + 1] ?? A.beatMelody[b], m);
        note(stepToward(m, next, A.scalePcs), 0.45, 0.8, { legato: true });
      }
    }
  } else {
    const tones = voice(pcs, lo, hi);
    if (id === 'piano') {
      if (pos === 0 && sub === 0) note(tones.slice(0, 4), 3.9, 0.85);
      else if (L > 0.55 && pos === 2 && sub === 0) note(voice(pcs, lo + 5, hi).slice(0, 3), 1.9, 0.55);
    } else if (id === 'violin') {
      if (pos === 0 && sub === 0) {
        const n = tones[bar % 2 === 0 ? 0 : 1];
        note(L > 0.5 ? [n, tones[2] ?? n + 7] : n, 3.95, 0.9, { legato: true });
      }
    } else if (sub === 0 && (pos === 0 || pos === 2)) {
      note(pos === 0 ? tones[0] : tones[2] ?? tones[0], 1.9, 0.75, { legato: true, muted: true });
    }
  }
  return out;
}
