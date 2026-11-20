// Color → mood. A point on the color pad becomes a blend of genres (weights) and a strength.
// Each genre has an anchor on the pad (hue = x, white→pure→black = y). Weights fall off with distance
// to each anchor; strength is highest at pure colors and fades to 0 toward white and black (= the song as it is).
// This mapping is a UI heuristic. The mood *model* (server) decides what a genre blend does to each instrument.

export const PAD_ANCHORS = {
  rock: [356 / 360, 0.44],
  lofi: [24 / 360, 0.68],
  hiphop: [47 / 360, 0.55],
  edm: [172 / 360, 0.3],
  cinematic: [222 / 360, 0.66],
  jazz: [272 / 360, 0.4],
};
const HUE_SIGMA = 46 / 360, Y_SIGMA = 0.28;
export const INSTRUMENT_COLORS = { vocals: '#ff5fa2', drums: '#ff4d5e', bass: '#ff9f43', guitar: '#3ddc84', piano: '#ffd84d', other: '#a77bff' };
export const INSTRUMENT_ICONS = { vocals: '🎤', drums: '🥁', bass: '🎸', guitar: '🎸', piano: '🎹', other: '✦' };

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const hueDist = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

export function padToMood(x, y, genres) {
  const raw = {};
  let sum = 0;
  for (const g of genres) {
    const [gx, gy] = PAD_ANCHORS[g.id] ?? [0, 0.5];
    const w = Math.exp(-((hueDist(x, gx) / HUE_SIGMA) ** 2) - ((y - gy) / Y_SIGMA) ** 2);
    raw[g.id] = w; sum += w;
  }
  const weights = {};
  let kept = 0;
  for (const g of genres) { const w = raw[g.id] / (sum || 1); weights[g.id] = w < 0.03 ? 0 : w; kept += weights[g.id]; }
  for (const id in weights) weights[id] /= kept || 1;
  return { weights, amount: clamp01(1.3 - Math.abs(y - 0.5) * 2.6) };
}

// Where a hand-edited blend sits on the pad (weighted circular mean of the anchors).
export function moodToPad(weights) {
  let sx = 0, sy = 0, yy = 0, tot = 0;
  for (const [id, w] of Object.entries(weights)) {
    const a = PAD_ANCHORS[id]; if (!a || !w) continue;
    sx += w * Math.cos(a[0] * 2 * Math.PI); sy += w * Math.sin(a[0] * 2 * Math.PI); yy += w * a[1]; tot += w;
  }
  if (!tot) return [0.5, 0.5];
  return [((Math.atan2(sy, sx) / (2 * Math.PI)) + 1) % 1, yy / tot];
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

// The mood's color: genre colors mixed by weight, washed toward gray as strength drops.
export function moodColor(weights, amount, genres) {
  let acc = [0, 0, 0], tot = 0;
  for (const g of genres) {
    const w = weights[g.id] || 0; if (!w) continue;
    const c = hexRgb(g.color); acc = acc.map((v, i) => v + c[i] * w); tot += w;
  }
  if (!tot) return '#8a8a99';
  const mixed = acc.map((v) => v / tot), gray = [138, 138, 153];
  return rgbHex(mixed.map((v, i) => gray[i] + (v - gray[i]) * (0.25 + 0.75 * amount)));
}

export function moodLabel(weights, amount, genres) {
  if (amount < 0.05) return { label: 'As recorded', desc: 'Pure white or black leaves the song untouched. Move toward a color.' };
  const top = genres.map((g) => ({ g, w: weights[g.id] || 0 })).filter((t) => t.w > 0.12).sort((a, b) => b.w - a.w).slice(0, 2);
  const label = top.map((t) => t.g.name).join(' × ');
  const desc = top.length > 1 ? `${Math.round(top[0].w * 100)} · ${Math.round(top[1].w * 100)} blend` : top[0].g.blurb;
  return { label, desc: `${desc} · ${Math.round(amount * 100)}% strength` };
}

// ---- Pad color space: x = hue, y = white (top) → pure hue (middle) → black (bottom) ----
export function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
export function padToRgb(x, y) {
  return y < 0.5 ? hsvToRgb(x * 360, y * 2, 1) : hsvToRgb(x * 360, 1, 1 - (y - 0.5) * 2);
}
