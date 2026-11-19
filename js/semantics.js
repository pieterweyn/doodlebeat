// Color → music semantics.
// Each color channel carries a *role* for the instrument assigned to it;
// the channel intensity sets how much (volume + busyness) that instrument contributes.
// The mixed color as a whole sets the global harmonic color, tone and space.
// PLUGIN POINT: replace moodFromLevels with an AI mapping (e.g. color → text prompt for a generative model).

export const CHANNEL_ORDER = ['R', 'G', 'B'];
export const CHANNELS = {
  R: { name: 'Red', color: '#ff4d5e', meaning: 'Energy', blurb: 'Driving rhythm, accents & stabs in a higher register. More red = busier & louder.' },
  G: { name: 'Green', color: '#3ddc84', meaning: 'Flow', blurb: 'Melody & arpeggios that trace the song’s own harmony. More green = more motion.' },
  B: { name: 'Blue', color: '#4d8dff', meaning: 'Depth', blurb: 'Long, low, spacious tones with extra reverb. More blue = fuller pads.' },
};

const hx = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
export const levelsToHex = ({ R, G, B }) => `#${hx(R)}${hx(G)}${hx(B)}`;
export const hexToLevels = (hex) => ({
  R: parseInt(hex.slice(1, 3), 16) / 255,
  G: parseInt(hex.slice(3, 5), 16) / 255,
  B: parseInt(hex.slice(5, 7), 16) / 255,
});

const HUES = [
  // [maxHue, label, chord extension, description]
  [20, 'Fiery', 'add9', 'bright add9 voicings, punchy'],
  [50, 'Warm', 'add9', 'sunny add9 voicings, warm'],
  [75, 'Sunny', '6', 'sweet sixth chords, open'],
  [160, 'Fresh', '6', 'pastoral sixths, natural'],
  [200, 'Cool', '7', 'cool seventh chords, airy'],
  [250, 'Melancholic', '7', 'minor-leaning sevenths, deep'],
  [300, 'Dreamy', '79', 'lush 7th + 9th clusters, hazy'],
  [340, 'Romantic', '79', 'rich extended chords, tender'],
  [361, 'Fiery', 'add9', 'bright add9 voicings, punchy'],
];

export function moodFromLevels({ R, G, B }) {
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
  let h = 0;
  if (d) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
    if (h < 0) h += 360;
  }
  const sum = R + G + B || 1;
  const tone = 0.7 + 0.6 * l + 0.2 * s; // filter brightness multiplier
  const reverb = 0.6 + 0.9 * (B / sum) + 0.3 * (1 - l); // reverb send multiplier

  if (max < 0.04) return { label: 'Silence', desc: 'Raise a channel to bring an instrument in.', extension: 'triad', tone: 1, reverb: 1, hue: h };
  let label, extension, desc;
  if (s < 0.18) { label = l > 0.6 ? 'Clear' : 'Neutral'; extension = 'triad'; desc = 'plain triads, balanced'; }
  else [, label, extension, desc] = HUES.find(([mh]) => h < mh);
  const prefix = l < 0.25 ? 'Dark · ' : l > 0.75 ? 'Airy · ' : '';
  const bright = tone > 1.15 ? 'bright tone' : tone < 0.9 ? 'mellow tone' : 'balanced tone';
  return { label: prefix + label, desc: `${desc[0].toUpperCase() + desc.slice(1)}; ${bright}.`, extension, tone, reverb, hue: h };
}
