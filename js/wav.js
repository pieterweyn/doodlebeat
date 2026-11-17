// AudioBuffer → 16-bit PCM WAV Blob
export function encodeWav(buffer) {
  const nCh = buffer.numberOfChannels, sr = buffer.sampleRate, len = buffer.length;
  const dataSize = len * nCh * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nCh, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * nCh * 2, true); view.setUint16(32, nCh * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, dataSize, true);
  const chs = [];
  for (let c = 0; c < nCh; c++) chs.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++, o += 2) {
    const v = Math.max(-1, Math.min(1, chs[c][i]));
    view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
