import { useEffect, useRef, useState } from 'react';
import { audioTracks, clamp, projectDuration, visualLayers, type Project, type StoredAsset } from '../core/project';
import { waveform } from '../core/wav';
import { Composition } from '../infrastructure/composition';
import { decodeAudio } from '../infrastructure/media';
import { mixAudio } from '../infrastructure/mix';
import type { ErrorCode } from '../locales';

export function usePreview(project: Project, assets: ReadonlyMap<string, StoredAsset>, report: (error: ErrorCode) => void) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const composition = useRef<Composition | null>(null);
  const audio = useRef<AudioBuffer | null>(null);
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const running = useRef({ position: 0, active: false, frame: 0, token: 0 });
  const current = useRef({ project, report });
  current.current = { project, report };
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visualReady, setVisualReady] = useState(false);
  const [soundReady, setSoundReady] = useState(false);
  const [bars, setBars] = useState<number[]>([]);
  const [level, setLevel] = useState(0);
  const [bass, setBass] = useState(0);
  const duration = projectDuration(project, assets);

  const stop = useRef<() => void>(() => undefined);
  function halt() {
    running.current.token++;
    running.current.active = false;
    cancelAnimationFrame(running.current.frame);
    composition.current?.pause();
    try { source.current?.stop(); } catch { /* source already ended */ }
    source.current?.disconnect();
    source.current = null;
    setPlaying(false);
    setLevel(0);
    setBass(0);
  }
  stop.current = halt;

  // Serialize prepares so rapid trim/scrub gestures don't race video seeks or image decoders.
  const paintQueue = useRef<Promise<void>>(Promise.resolve());
  function paint(at: number, play: boolean, token = running.current.token) {
    const compositor = composition.current;
    if (!compositor) return Promise.resolve();
    const snapshot = current.current.project;
    const work = paintQueue.current.catch(() => undefined).then(async () => {
      if (token !== running.current.token || compositor !== composition.current) return;
      if (!play || compositor.hasMotion(snapshot)) await compositor.prepare(snapshot, at, play);
      if (token === running.current.token && compositor === composition.current && canvas.current) {
        compositor.draw(canvas.current, snapshot, at);
      }
    });
    paintQueue.current = work;
    return work;
  }

  const visual = visualLayers(project);
  const tracks = audioTracks(project);
  const visualSources = JSON.stringify(visual.flatMap(layer => layer.kind === 'media' ? [[layer.id, layer.asset]] : []));
  const visualEdit = JSON.stringify([visual, project.hidden]);
  const audioEdit = JSON.stringify(tracks);

  useEffect(() => {
    const controller = new AbortController();
    const compositor = new Composition(controller.signal);
    const token = running.current;
    setVisualReady(false);
    composition.current = compositor;
    void compositor.open(current.current.project, assets).then(() => {
      if (controller.signal.aborted) return;
      setVisualReady(true);
      return paint(token.position, false);
    }).catch(() => { if (!controller.signal.aborted) current.current.report('1004'); });
    return () => {
      stop.current();
      controller.abort();
      compositor.close();
      if (composition.current === compositor) composition.current = null;
    };
  }, [visualSources, assets]);

  const decoded = useRef(new Map<string, AudioBuffer>());
  useEffect(() => {
    const controller = new AbortController();
    setSoundReady(false);
    const snapshot = current.current.project;
    void (async () => {
      const active = audioTracks(snapshot);
      const buffers = new Map<string, AudioBuffer>();
      for (const track of active) {
        const asset = assets.get(track.asset);
        if (!asset || buffers.has(asset.id)) continue;
        const buffer = decoded.current.get(asset.id) ?? await decodeAudio(asset.blob);
        controller.signal.throwIfAborted();
        buffers.set(asset.id, buffer);
      }
      decoded.current = buffers;
      const buffer = await mixAudio(snapshot, assets, controller.signal, buffers);
      if (controller.signal.aborted) return;
      audio.current = buffer;
      const first = snapshot.audio ? buffers.get(snapshot.audio) : undefined;
      setBars(first ? waveform(first.getChannelData(0)) : []);
      setSoundReady(true);
    })().catch(() => { if (!controller.signal.aborted) current.current.report('2002'); });
    return () => { controller.abort(); stop.current(); audio.current = null; };
  }, [audioEdit, assets]);

  useEffect(() => {
    if (running.current.active) stop.current();
    const next = Math.min(running.current.position, duration);
    running.current.position = next;
    setPosition(next);
    if (visualReady) void paint(next, false).catch(() => current.current.report('1004'));
  }, [visualEdit, duration, visualReady]);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop.current(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      void context.current?.close().catch(() => undefined);
    };
  }, []);

  async function play() {
    if (running.current.active) { halt(); return; }
    if ((!visual.length && !tracks.length) || !visualReady || (tracks.length && !soundReady)) return;
    const state = running.current;
    const token = ++state.token;
    const initial = state.position >= duration - 50 ? 0 : state.position;
    const buffer = audio.current;
    state.active = true;
    setPlaying(true);
    try {
      if (buffer) {
        context.current ??= new AudioContext({ sampleRate: 48000 });
        await context.current.resume();
      }
      await paint(initial, false, token);
      if (token !== state.token) return;
      const engine = buffer ? context.current : null;
      const clock = engine ? () => engine.currentTime : () => performance.now() / 1000;
      const origin = clock();
      let analyser: AnalyserNode | undefined;
      const spectrum = new Uint8Array(256);
      if (buffer && engine && initial < buffer.duration * 1000) {
        const node = engine.createBufferSource();
        node.buffer = buffer;
        analyser = engine.createAnalyser();
        analyser.fftSize = 512;
        node.connect(analyser).connect(engine.destination);
        node.start(origin, initial / 1000);
        source.current = node;
      }
      const samples = buffer?.getChannelData(0);
      const tick = async () => {
        if (token !== state.token) return;
        state.position = Math.min(duration, initial + (clock() - origin) * 1000);
        setPosition(state.position);
        if (samples) {
          const start = Math.floor(state.position / 1000 * buffer!.sampleRate);
          let squares = 0;
          for (let i = start; i < Math.min(start + 512, samples.length); i++) squares += samples[i] ** 2;
          setLevel(Math.min(1, 4 * Math.sqrt(squares / 512)));
          if (analyser) {
            analyser.getByteFrequencyData(spectrum);
            setBass((spectrum[1] + spectrum[2] + spectrum[3]) / (3 * 255));
          }
        }
        await paint(state.position, true, token);
        if (token !== state.token) return;
        if (state.position >= duration) halt();
        else state.frame = requestAnimationFrame(() => void tick().catch(fail));
      };
      const fail = () => { if (token === state.token) { halt(); current.current.report('2002'); } };
      state.frame = requestAnimationFrame(() => void tick().catch(fail));
    } catch {
      if (token === state.token) { halt(); current.current.report('2002'); }
    }
  }
  function scrub(value: number) {
    halt();
    const at = clamp(value, 0, duration);
    running.current.position = at;
    setPosition(at);
    void paint(at, false).catch(() => current.current.report('1004'));
  }
  return { canvas, playing, position, duration, bars, level, bass, play, scrub, halt };
}
