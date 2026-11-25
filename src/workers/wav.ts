import { pcmWav } from '../core/wav';

self.addEventListener('message', (event: MessageEvent<{ channels: Float32Array[]; sampleRate: number }>) => {
  try {
    const data = pcmWav(event.data.channels, event.data.sampleRate);
    self.postMessage({ data }, { transfer: [data] });
  } catch {
    self.postMessage({ error: '3004' });
  }
});
