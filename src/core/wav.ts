export function pcmWav(channels: readonly Float32Array[], sampleRate: number) {
  const frames = channels[0]?.length ?? 0;
  if (!frames || channels.length > 2 || channels.some(channel => channel.length !== frames)) throw new Error('3004');
  const align = channels.length * 2;
  const result = new ArrayBuffer(44 + frames * align);
  const data = new DataView(result);
  const label = (offset: number, value: string) => Array.from(value).forEach((letter, i) => data.setUint8(offset + i, letter.charCodeAt(0)));
  label(0, 'RIFF'); data.setUint32(4, result.byteLength - 8, true);
  label(8, 'WAVE'); label(12, 'fmt '); data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); data.setUint16(22, channels.length, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * align, true);
  data.setUint16(32, align, true); data.setUint16(34, 16, true);
  label(36, 'data'); data.setUint32(40, frames * align, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      data.setInt16(44 + i * align + 2 * c, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
  }
  return result;
}

export function waveform(channel: Float32Array, count = 66) {
  return Array.from({ length: count }, (_, index) => {
    const begin = Math.floor(index * channel.length / count);
    const end = Math.floor((index + 1) * channel.length / count);
    let peak = 0;
    for (let offset = begin; offset < end; offset++) peak = Math.max(peak, Math.abs(channel[offset]));
    return peak;
  });
}
