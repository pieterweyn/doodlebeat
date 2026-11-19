// Synthesizes a short demo beat (96 BPM, A minor: Am–F–C–G) so the app works without a file.
import { playDrum, playNote } from './instruments.js';

const playBass = (ctx, out, midi, t, dur, vel = 0.8) => playNote(ctx, out, 'bass', midi, t, dur, vel);

export async function makeDemoBeat(sr = 44100) {
  const bpm = 96, beat = 60 / bpm, bars = 8, s16 = beat / 4;
  const ctx = new OfflineAudioContext(2, Math.ceil((bars * 4 * beat + 0.5) * sr), sr);
  const out = ctx.createGain();
  out.gain.value = 0.8;
  out.connect(ctx.destination);
  const roots = [45, 41, 48, 43]; // A2 F2 C3 G2
  const chords = [[57, 60, 64], [57, 60, 65], [55, 60, 64], [55, 59, 62]];
  for (let bar = 0; bar < bars; bar++) {
    const r = roots[bar % 4];
    for (let s = 0; s < 16; s++) {
      const t = (bar * 16 + s) * s16;
      if (s === 0 || s === 6 || s === 8 || (bar % 2 && s === 10)) playDrum(ctx, out, 'kick', t, 1);
      if (s === 4 || s === 12) playDrum(ctx, out, 'snare', t, 0.9);
      if (s % 2 === 0) playDrum(ctx, out, s === 14 ? 'openhat' : 'hat', t, s % 4 === 0 ? 0.8 : 0.5);
      if (s === 0) playBass(ctx, out, r, t, beat * 1.4);
      if (s === 6) playBass(ctx, out, r + 12, t, beat * 0.4, 0.7);
      if (s === 8) playBass(ctx, out, r, t, beat * 0.9);
      if (s === 11) playBass(ctx, out, r + 7, t, beat * 0.6, 0.7);
      if (s === 0 || s === 10) for (const m of chords[bar % 4]) playNote(ctx, out, 'piano', m, t, beat * 1.5, 0.45);
    }
  }
  return ctx.startRendering();
}
