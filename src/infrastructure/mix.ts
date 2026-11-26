import { audioTracks, trackDuration, type Project, type SoundStyle, type StoredAsset } from '../core/project';
import { logError } from './logger';
import { decodeAudio } from './media';

const sampleRate = 48_000;
export function rangePeak(buffer: AudioBuffer, from = 0, until = buffer.length) {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = from; i < until; i++) peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
}

function addTrack(context: OfflineAudioContext, buffer: AudioBuffer, style: SoundStyle) {
  const start = style.trim.start / 1000;
  const sourceLength = Math.min(buffer.duration - start, (style.trim.end - style.trim.start) / 1000);
  if (style.muted || !style.gain || sourceLength <= 0) return;
  const startAt = style.offset / 1000;
  const duration = sourceLength / style.rate;
  const endAt = startAt + duration;
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = style.rate;
  const gain = context.createGain();
  const rate = buffer.sampleRate || sampleRate;
  const peak = rangePeak(buffer, Math.floor(start * rate), Math.min(buffer.length, Math.ceil((start + sourceLength) * rate)));
  const volume = style.gain * (style.normalize && peak ? .9 / peak : 1);
  const scale = Math.min(1, duration * 1000 / (style.fadeIn + style.fadeOut || 1)) / 1000;
  const fadeIn = scale * style.fadeIn;
  const fadeOut = scale * style.fadeOut;
  gain.gain.setValueAtTime(fadeIn ? 0 : volume, startAt);
  if (fadeIn) gain.gain.linearRampToValueAtTime(volume, startAt + fadeIn);
  if (fadeOut) {
    gain.gain.setValueAtTime(volume, endAt - fadeOut);
    gain.gain.linearRampToValueAtTime(0, endAt);
  }
  source.connect(gain).connect(context.destination);
  source.start(startAt, start, sourceLength);
}

export async function mixAudio(project: Project, assets: ReadonlyMap<string, StoredAsset>,
  signal: AbortSignal, decoded?: ReadonlyMap<string, AudioBuffer>) {
  const tracks = audioTracks(project);
  if (!tracks.length) return null;
  const sources = new Map<string, AudioBuffer>();
  for (const track of tracks) {
    signal.throwIfAborted();
    const asset = assets.get(track.asset);
    if (!asset) {
      logError('mix.audio', 'missing_audio_asset', { code: '4002', meta: { trackId: track.id.slice(0, 8), assetId: track.asset.slice(0, 8) } });
      throw new Error('4002');
    }
    if (!sources.has(track.asset)) sources.set(track.asset, decoded?.get(track.asset) ?? await decodeAudio(asset.blob));
  }
  const channels = Math.max(1, ...[...sources.values()].map(buffer => buffer.numberOfChannels));
  const duration = Math.max(1, ...tracks.map(track => trackDuration(track.style)));
  let context: OfflineAudioContext;
  try { context = new OfflineAudioContext(channels, Math.round(duration * sampleRate / 1000), sampleRate); }
  catch {
    const fallbackRate = sources.values().next().value?.sampleRate || 44_100;
    context = new OfflineAudioContext(channels, Math.max(1, Math.round(duration * fallbackRate / 1000)), fallbackRate);
  }
  for (const track of tracks) addTrack(context, sources.get(track.asset)!, track.style);
  const buffer = await context.startRendering();
  signal.throwIfAborted();
  const peak = rangePeak(buffer);
  if (peak > .999) {
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let sample = 0; sample < data.length; sample++) data[sample] *= .999 / peak;
    }
  }
  return buffer;
}
