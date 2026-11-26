import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from 'react';
import { AudioLines, CheckCircle2, CloudDownload, Download, FolderOpen, Globe2, ImagePlus, Layers, LoaderCircle, LogOut, MessageCircle, Play, Redo2, Send, Sparkles, Square, Undo2, Upload, Volume2, VolumeX, WifiOff, Wrench, Type } from 'lucide-react';
import { Link, useApp } from '../app/context';
import { Bars, DiagnosticLogsBox, Modal, Notice } from '../app/shared';
import { audioTracks, clamp, createProject, initialSound, initialVisual, motion, newTrim, projectRefs, trackDuration, updateTrim, visualLayers, MAX_DURATION, MAX_LAYERS, MAX_TRACKS, type Project, type StoredAsset, type Trim } from '../core/project';
import { catalog, catalogAsset, type Sound } from '../infrastructure/catalog';
import { audioFormats, importMedia } from '../infrastructure/media';
import { keepSound, load, personalSound } from '../infrastructure/storage';
import { errorCode, type ErrorCode } from '../locales';
import { getDiagnosticLogs, logError, logWarn } from '../infrastructure/logger';
import { useDraft } from './draft';
import { ExportDialog } from './export-dialog';
import { SendToWhatsAppModal } from './whatsapp-send-modal';
import { Inspector, type Tab } from './inspector';
import { capabilities } from './pages';
import { probeCloudGateway } from '../infrastructure/gateway';
import type { GatewayCapabilitiesResponse } from '@stickerwave/contracts';
import { Wavi } from './wavi';
import { ThemeControl } from './preferences';
import { usePreview } from './preview';
import { SoundLibrary } from './sounds';

const visualAccept = '.png,.jpg,.jpeg,.webp,.gif,.apng,.avif,.bmp,.ico,.heic,.heif,.tif,.tiff,.svg,.mp4,.webm,image/*,video/mp4,video/webm';
const audioAccept = '.mp3,.wav,.ogg,.opus,.m4a,.aac,.webm,.mp4,audio/*';
const tabs = { media: ImagePlus, text: Type, audio: AudioLines, layers: Layers };
type Session = { project: Project; assets: ReadonlyMap<string, StoredAsset>; existing: boolean; missingLocalMedia?: boolean };
type Job = 'loading' | 'recording';
type Recording = { recorder: MediaRecorder; stream: MediaStream; stop: (discard?: boolean) => void };
const timecode = (ms: number) => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}.${Math.floor(ms % 1000 / 100)}`;
};

export default function Studio({ id, query }: { id?: string; query: string }) {
  const { copy } = useApp();
  const [session, setSession] = useState<Session | null>(() => id ? null : { project: createProject(copy.untitled), assets: new Map(), existing: false });
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!id) return;
    let active = true;
    load(id).then(data => {
      if (!active) return;
      if (data) setSession({ ...data, existing: true });
      else {
        logWarn('studio', 'project_not_found_on_load', { meta: { projectId: id } });
        setMissing(true);
      }
    }).catch((err) => {
      logError('studio', 'load_project_failed', { code: '4002', detail: err, meta: { projectId: id } });
      if (active) setMissing(true);
    });
    return () => { active = false; };
  }, [id]);
  if (!session) return missing ? <section className="wrap page"><div className="empty"><FolderOpen size={36} />
    <h1>{copy.missingTitle}</h1><p>{copy.missing}</p><Link href="/projects" className="button button-green">{copy.browseProjects}</Link></div></section>
    : <p className="wrap page" role="status">{copy.starting}</p>;
  return <Editor session={session} query={query} />;
}

function Editor({ session, query }: { session: Session; query: string }) {
  const { copy, locale, navigate, toggleLanguage, logout } = useApp();
  const params = new URLSearchParams(query);
  const [tab, setTab] = useState<Tab>('media');
  const [library, setLibrary] = useState(false);
  const [activeTrack, setActiveTrack] = useState('primary-audio');
  const [exporting, setExporting] = useState(false);
  const [exportFocus, setExportFocus] = useState<'whatsapp' | 'all'>('all');
  const [sendingWa, setSendingWa] = useState(false);
  const [gwCaps, setGwCaps] = useState<GatewayCapabilitiesResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [notice, setNotice] = useState<ErrorCode>();
  const [message, setMessage] = useState(session.missingLocalMedia ? copy.missingLocalMedia : params.get('restored') ? copy.restored : '');
  const [dragging, setDragging] = useState(false);
  const [previewMode, setPreviewMode] = useState<'studio' | 'whatsapp'>('studio');
  const [offline, setOffline] = useState(!navigator.onLine);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const mediaInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const recording = useRef<Recording | null>(null);
  const operation = useRef<AbortController | null>(null);
  const capturePending = useRef(false);
  const historyRef = useRef<ErrorCode[]>([]);
  const soundParam = useRef(params.get('sound'));
  const personalParam = useRef(params.get('personal'));
  const draggingCanvas = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const draft = useDraft(session.project, session.assets, session.existing, next => {
    if (location.pathname === '/studio') navigate(`/studio/${next.id}`, true, true);
  });
  const { project, assets, change } = draft;
  const selectedVisual = project.media ? assets.get(project.media) : undefined;
  const selectedAudio = project.audio ? assets.get(project.audio) : undefined;
  const visualVideo = selectedVisual && motion(selectedVisual, project.visual) ? selectedVisual : undefined;
  const layers = visualLayers(project);
  const tracks = audioTracks(project);
  const haveComposition = Boolean(layers.length || tracks.length);
  const microphone = typeof navigator.mediaDevices?.getUserMedia === "function" && audioFormats().length > 0;

  function report(code: ErrorCode) {
    setMessage('');
    setNotice(code);
    historyRef.current = [...historyRef.current.slice(-19), code];
    logWarn('studio', 'ui_error_reported', { code, meta: { projectId: project.id } });
  }
  const preview = usePreview(project, assets, report);

  useEffect(() => {
    let active = true;
    void probeCloudGateway().then((probe) => {
      if (active && probe) setGwCaps(probe.capabilities);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const network = () => setOffline(!navigator.onLine);
    const background = () => {
      if (!document.hidden) return;
      const active = recording.current;
      if (active) active.stop();
      else if (capturePending.current) operation.current?.abort();
    };
    document.addEventListener('visibilitychange', background);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    return () => {
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      operation.current?.abort();
      recording.current?.stop(true);
    };
  }, []);
  

  function acceptAudio(asset: StoredAsset) {
    const current = draft.state.current;
    if (audioTracks(current.project).length >= MAX_TRACKS) throw new Error('1002');
    const nextAssets = projectRefs(current.project).filter(id => id !== asset.id);
    const total = nextAssets.reduce((sum, id) => sum + (current.assets.get(id)?.size ?? 0), asset.size);
    if (total > 95 * 1024 ** 2) throw new Error('1002');
    const primary = !current.project.audio;
    const id = primary ? 'primary-audio' : crypto.randomUUID();
    const style = { ...initialSound, trim: newTrim(asset) };
    change(previous => primary ? { ...previous, audio: asset.id, sound: style } :
      { ...previous, tracks: [...previous.tracks, { id, asset: asset.id, style }] }, { additions: [asset], critical: true });
    setActiveTrack(id);
  }
  function removeTrack(id: string) {
    change(previous => {
      if (id !== 'primary-audio') return { ...previous, tracks: previous.tracks.filter(track => track.id !== id) };
      const [next, ...remaining] = previous.tracks;
      return { ...previous, audio: next?.asset ?? null, sound: next?.style ?? initialSound, tracks: remaining };
    });
    setActiveTrack('primary-audio');
  }
  function keepTrack(asset: StoredAsset) {
    void keepSound(asset).then(() => setMessage(copy.soundKept)).catch(error => report(errorCode(error, '4001')));
  }
  function extract() {
    if (!selectedVisual?.mime.startsWith('video/')) return;
    void runImport(async signal => {
      const { extractSound } = await import('../infrastructure/codec');
      const blob = await extractSound(selectedVisual.blob, selectedVisual.mime, signal);
      acceptAudio(await importMedia(blob, selectedVisual.name.replace(/\.[^.]+$/, '') + '.wav', 'audio', signal));
      setTab('audio');
    });
  }
  function acceptVisual(files: StoredAsset[]) {
    const current = draft.state.current;
    let total = projectRefs(current.project).reduce((sum, id) => sum + (current.assets.get(id)?.size ?? 0), 0);
    const additions: StoredAsset[] = [];
    const available = [...current.project.visualOptions];
    for (const asset of files) {
      const duplicate = available.find(id => current.assets.get(id)?.sha256 === asset.sha256) ?? additions.find(added => added.sha256 === asset.sha256)?.id;
      if (duplicate) continue;
      if (available.length >= 8 || total + asset.size > 95 * 1024 ** 2) { report('1002'); break; }
      available.push(asset.id);
      additions.push(asset);
      total += asset.size;
    }
    if (!additions.length) return;
    change(previous => {
      if (!previous.media && visualLayers(previous).length >= MAX_LAYERS) return { ...previous, visualOptions: available };
      return { ...previous, visualOptions: available, media: additions[0].id, visual: { ...initialVisual, trim: newTrim(additions[0]) } };
    }, { additions, critical: true });
  }

  async function runImport(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current || exporting) return;
    const controller = new AbortController();
    operation.current = controller;
    preview.halt();
    setJob('loading'); setNotice(undefined); setMessage('');
    try { await work(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) {
        const mapped = errorCode(error, '1003');
        logError('studio', 'import_operation_failed', { code: mapped, detail: error, meta: { projectId: project.id } });
        report(mapped);
      }
    }
    finally { if (operation.current === controller) { operation.current = null; setJob(null); } }
  }
  function importFiles(files: FileList | readonly File[], kind: 'visual' | 'audio') {
    if (!files.length) return;
    if (kind === 'audio') {
      void runImport(async signal => {
        const file = files[0];
        acceptAudio(await importMedia(file, file.name, 'audio', signal));
        setTab('audio');
      });
      return;
    }
    void runImport(async signal => {
      const selected = Array.from(files);
      const incoming: StoredAsset[] = [];
      let rejected: ErrorCode | undefined = selected.length > 8 ? '1002' : undefined;
      for (const file of selected.slice(0, 8)) {
        try { incoming.push(await importMedia(file, file.name, 'visual', signal)); }
        catch (error) {
          if (signal.aborted) throw error;
          const mapped = errorCode(error, '1003');
          logWarn('studio', 'import_media_item_rejected', {
            code: mapped,
            detail: error,
            meta: { mime: file.type || 'unknown', bytes: file.size },
          });
          rejected = mapped;
        }
      }
      signal.throwIfAborted();
      if (incoming.length) acceptVisual(incoming);
      if (rejected) report(rejected);
      setTab('media');
    });
  }

  async function choose(sound: Sound | string | StoredAsset) {
    setLibrary(false);
    await runImport(async signal => {
      const item = typeof sound === 'string' ? (await catalog()).find(value => value.id === sound) : sound;
      if (!item) throw new Error('1001');
      const asset = 'blob' in item ? item : await catalogAsset(item, locale, signal);
      signal.throwIfAborted();
      acceptAudio(asset);
      setTab('audio');
      setMessage(copy.audioAdded);
    });
  }
  const chooseInitial = useRef(choose);
  chooseInitial.current = choose;
  useEffect(() => {
    if (soundParam.current) {
      void chooseInitial.current(soundParam.current);
      soundParam.current = null;
    } else if (personalParam.current) {
      void personalSound(personalParam.current).then(asset => {
        if (asset) return chooseInitial.current(asset);
      }).catch(() => report('4001'));
      personalParam.current = null;
    }
  }, []);

  function demo() {
    void runImport(async signal => {
      const [response, sounds] = await Promise.all([fetch('/images/wavi.webp', { signal }), catalog()]);
      if (!response.ok || !sounds.length) throw new Error('1003');
      const image = await importMedia(await response.blob(), 'Wavi.webp', 'visual', signal);
      const sound = await catalogAsset(sounds[0], locale, signal);
      signal.throwIfAborted();
      acceptVisual([image]);
      acceptAudio(sound);
    });
  }

  async function record() {
    if (recording.current) { recording.current.stop(); return; }
    if (operation.current || !microphone || exporting || audioTracks(draft.state.current.project).length >= MAX_TRACKS) return;
    const controller = new AbortController();
    operation.current = controller;
    preview.halt();
    setNotice(undefined);
    setMessage('');
    setJob('loading');
    capturePending.current = true;
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      capturePending.current = false;
      if (controller.signal.aborted || document.hidden) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('2001');
      }
      const microphoneStream = stream;
      const recorder = new MediaRecorder(microphoneStream, { mimeType: audioFormats()[0] });
      const chunks: Blob[] = [];
      let discard = false;
      let stopped = false;
      const timer = window.setTimeout(() => recording.current?.stop(), 10_000);
      const stop = (ignore = false) => {
        if (stopped) return;
        stopped = true; discard = ignore;
        clearTimeout(timer);
        if (recorder.state !== 'inactive') recorder.stop();
        microphoneStream.getTracks().forEach(track => track.stop());
        recording.current = null;
        if (!ignore && !controller.signal.aborted) setJob('loading');
      };
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        stop(true);
        if (!controller.signal.aborted) { report('2002'); operation.current = null; setJob(null); }
      });
      recorder.addEventListener('stop', () => {
        stop();
        if (discard || controller.signal.aborted) return;
        const type = recorder.mimeType || audioFormats()[0];
        const extension = type.startsWith('audio/mp4') ? 'm4a' : type.startsWith('audio/ogg') ? 'ogg' : 'webm';
        const blob = new Blob(chunks, { type });
        void importMedia(blob, `${locale === 'pt' ? 'Gravação' : 'Recording'}.${extension}`, 'audio', controller.signal)
          .then(asset => { if (!controller.signal.aborted) acceptAudio(asset); })
          .catch(error => { if (!controller.signal.aborted) report(errorCode(error, '2002')); })
          .finally(() => { if (operation.current === controller) { operation.current = null; setJob(null); } });
      });
      recording.current = { recorder, stream, stop };
      recorder.start(250);
      setJob('recording');
    } catch {
      capturePending.current = false;
      recording.current?.stop(true);
      stream?.getTracks().forEach(track => track.stop());
      if (!controller.signal.aborted) report('2001');
      operation.current = null;
      setJob(null);
    }
  }

  function selectVisual(file: StoredAsset) {
    if (project.media === file.id) return;
    preview.scrub(0);
    change(previous => ({ ...previous, media: file.id, visual: { ...initialVisual, trim: newTrim(file) } }));
  }
  function removeVisual(id: string) {
    change(previous => {
      const visualOptions = previous.visualOptions.filter(item => item !== id);
      const layers = previous.layers.filter(layer => layer.kind !== 'media' || layer.asset !== id);
      const order = previous.order.filter(key => key.startsWith('primary-') || layers.some(layer => layer.id === key));
      const hidden = previous.hidden.filter(key => key.startsWith('primary-') || layers.some(layer => layer.id === key));
      if (previous.media !== id) return { ...previous, visualOptions, layers, order, hidden };
      const next = visualOptions[0] ? assets.get(visualOptions[0]) : null;
      return { ...previous, visualOptions, layers, order, hidden, media: next?.id ?? null,
        visual: { ...initialVisual, trim: next ? newTrim(next) : initialVisual.trim } };
    });
  }
  function resetVisual() {
    change(previous => ({ ...previous, visual: { ...initialVisual, trim: previous.visual.trim } }));
  }
  const controls = useRef({ undo: draft.undo, play: preview.play, locked: false });
  controls.current = { undo: draft.undo, play: preview.play, locked: Boolean(library || exporting || diagnostics || job) };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable]')) return;
      if (controls.current.locked) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      importFiles(files, files[0].type.startsWith('audio/') ? 'audio' : 'visual');
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (controls.current.locked || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
        event.preventDefault();
        controls.current.undo(key === 'y' || event.shiftKey);
      }
      if (event.code === 'Space' && !(event.target instanceof HTMLElement && event.target.closest('button,a'))) {
        event.preventDefault(); void controls.current.play();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const [name, setName] = useState<string | null>(null);
  const statusLabel = copy[draft.status];
  const viewLength = visualVideo ? project.visual.trim.end - project.visual.trim.start : preview.duration;
  const audioLength = selectedAudio ? trackDuration(project.sound) - project.sound.offset : 0;
  const clipPosition = (start: number, length: number) => ({
    marginLeft: `${Math.min(100, start / preview.duration * 100)}%`,
    width: `${Math.max(0, Math.min(preview.duration - start, length) / preview.duration * 100)}%`,
  });
  const rangedBars = selectedAudio && preview.bars.length ? preview.bars.slice(
    Math.floor(project.sound.trim.start / selectedAudio.duration * preview.bars.length),
    Math.max(1, Math.ceil(project.sound.trim.end / selectedAudio.duration * preview.bars.length))
  ) : [];
  const reportCode = notice ?? draft.failure;
  const exampleLabel = copy.example;
  const rename = (value: string) => {
    const title = value.trim().slice(0, 80);
    if (title) change(previous => previous.name === title ? previous : { ...previous, name: title }, { group: 'name' });
  };
  return <div className="studio">
    <header className="studio-header">
      <Link className="studio-brand" href="/" aria-label={copy.home} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); void draft.drain().then(() => navigate('/')); } }}><img src="/images/mark.svg" width="36" height="36" alt="" /></Link>
      <Link className="icon-button projects-icon" href="/projects" title={copy.projects} aria-label={copy.projects} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); void draft.drain().then(() => navigate('/projects')); } }}><FolderOpen size={21} /></Link>
      <div className="project-heading">
        <input aria-label={copy.projectName} value={name ?? project.name} maxLength={80} onChange={event => {
          setName(event.target.value); rename(event.target.value);
        }} onBlur={() => setName(null)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        <div className={`save-state ${draft.status}`} role="status">{draft.status === 'saving' ? <LoaderCircle size={13} className="spin" /> : <CloudDownload size={14} />}<span>{statusLabel}</span></div>
      </div>
      {offline && <span className="offline-label"><WifiOff size={16} />{copy.offline}</span>}
      <div className="studio-actions">
        <button className="icon-button" title={copy.undo} aria-label={copy.undo} onClick={() => draft.undo()} disabled={draft.history.undo === 0 || Boolean(job)}><Undo2 size={20} /></button>
        <button className="icon-button" title={copy.redo} aria-label={copy.redo} onClick={() => draft.undo(true)} disabled={draft.history.redo === 0 || Boolean(job)}><Redo2 size={20} /></button>
        <button className="icon-button studio-diagnostic" title={copy.diagnostic} aria-label={copy.diagnostic} onClick={() => setDiagnostics(true)}><Wrench size={17} /></button>
        <button className="language studio-lang" aria-label={`${locale.toUpperCase()} · ${copy.language}`} onClick={toggleLanguage}><Globe2 size={16} />{locale === 'pt' ? 'PT' : 'EN'}</button>
        <button className="icon-button studio-logout" title={copy.signOut} aria-label={copy.signOut} onClick={() => void draft.drain().then(() => logout())}><LogOut size={17} /></button>
        <Link className="icon-button studio-wa-config" href="/whatsapp" title={copy.whatsappConfigure} aria-label={copy.whatsappConfigure} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); void draft.drain().then(() => navigate('/whatsapp')); } }}><MessageCircle size={18} /></Link>
        <button className="button button-outline wa-send-header-btn" aria-label={gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled ? copy.waCloudWhatsAppAction : copy.waSendButton} title={gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled ? copy.waCloudWhatsAppAction : copy.waSendButton} onClick={() => { preview.halt(); if (gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled) { setExportFocus('whatsapp'); setExporting(true); } else setSendingWa(true); }} disabled={!haveComposition || Boolean(job)}><Send size={17} /><span>{gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled ? copy.waCloudWhatsAppAction : copy.waSendButton}</span></button>
        <button className="button button-green export-button" onClick={() => { preview.halt(); setExportFocus('all'); setExporting(true); }} disabled={!haveComposition || Boolean(job)}><Download size={18} />{copy.export}</button>
      </div>
    </header>
    {(reportCode || message || job === 'loading') && <div className="studio-notices">
      {reportCode && <Notice error><span>{copy.errors[reportCode]} [SW-{reportCode}]</span>
        {reportCode === '4003' && <button className="button button-small" onClick={() => void draft.copyDraft().then(next => navigate(`/studio/${next.id}`, true))
          .catch(error => report(errorCode(error, '4001')))}>{copy.conflictAction}</button>}
        {reportCode === '4001' && <button className="text-button" onClick={() => void draft.drain()}>{copy.retry}</button>}
        {notice && <button className="text-button" onClick={() => setNotice(undefined)}>{copy.close}</button>}
      </Notice>}
      {!reportCode && message && <Notice><span>{message}</span><button className="text-button" onClick={() => setMessage('')}>{copy.close}</button></Notice>}
      {!reportCode && !message && job !== 'loading' && selectedVisual?.mime.startsWith('video/') && !tracks.length &&
        <Notice><span>{copy.videoAudioHint}</span></Notice>}
      {job === 'loading' && <Notice><span className="inline-status"><LoaderCircle size={16} className="spin" />{copy.loading}</span>
        <button className="text-button" onClick={() => operation.current?.abort()}>{copy.cancel}</button></Notice>}
    </div>}
    <input hidden ref={mediaInput} type="file" accept={visualAccept} multiple aria-label={copy.addMedia} onChange={event => {
      if (event.currentTarget.files) importFiles(event.currentTarget.files, 'visual'); event.currentTarget.value = '';
    }} />
    <input hidden ref={audioInput} type="file" accept={audioAccept} aria-label={copy.addAudio} onChange={event => {
      if (event.currentTarget.files) importFiles(event.currentTarget.files, 'audio'); event.currentTarget.value = '';
    }} />
    <div className="workbench">
      <nav className="tool-rail" aria-label={copy.properties}>
        {(Object.keys(tabs) as Tab[]).map(key => {
          const Icon = tabs[key];
          return <button key={key} className={tab === key ? 'active' : ''} aria-pressed={tab === key} onClick={() => setTab(key)}><Icon size={21} /><span>{copy[key]}</span></button>;
        })}
      </nav>
      <section className={`workspace-preview ${dragging ? 'dragging' : ''}`} aria-label={copy.composition}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => {
          event.preventDefault(); setDragging(false);
          const dropped = Array.from(event.dataTransfer.files);
          if (!dropped.length) return;
          const isAudio = (file: File) => file.type.startsWith('audio/') || /\.(mp3|wav|ogg|opus|m4a|aac)$/i.test(file.name);
          const audioFiles = dropped.filter(isAudio);
          const visualFiles = dropped.filter(file => !isAudio(file));
          if (visualFiles.length) importFiles(visualFiles, 'visual');
          else if (audioFiles.length) importFiles(audioFiles, 'audio');
        }}>
        <header>
          <span><span className="preview-dot" />{copy.composition}</span>
          <div className="preview-header-right">
            {haveComposition && <div className="segmented preview-mode-toggle" role="group" aria-label={copy.preview}>
              <button type="button" aria-pressed={previewMode === 'studio'} onClick={() => setPreviewMode('studio')}>{copy.studioMode}</button>
              <button type="button" aria-pressed={previewMode === 'whatsapp'} onClick={() => setPreviewMode('whatsapp')}>{copy.whatsappPreview}</button>
            </div>}
            <span>512 × 512</span>
          </div>
        </header>
        <div className="studio-stepper" role="group" aria-label={copy.stepsTitle}>
          <button type="button" className={`studio-step ${layers.length > 0 ? 'done' : ''}`} disabled={Boolean(job)} onClick={() => mediaInput.current?.click()}>
            {layers.length > 0 && <CheckCircle2 size={14} />}
            <span>{copy.studioStep1}</span>
          </button>
          <button type="button" className={`studio-step ${tracks.length > 0 ? 'done' : ''}`} disabled={Boolean(job)} onClick={() => { preview.halt(); setLibrary(true); }}>
            {tracks.length > 0 && <CheckCircle2 size={14} />}
            <span>{copy.studioStep2}</span>
          </button>
          <button type="button" className="studio-step cta" disabled={!haveComposition || Boolean(job)} onClick={() => {
            preview.halt();
            if (gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled) { setExportFocus('whatsapp'); setExporting(true); }
            else if (gwCaps?.whatsappBotEnabled) setSendingWa(true);
            else { setExportFocus('whatsapp'); setExporting(true); }
          }}>
            <Send size={13} />
            <span>{copy.studioStep3}</span>
          </button>
        </div>
        <div className={`stage ${previewMode === 'whatsapp' && haveComposition ? 'whatsapp-stage' : ''}`}>
          <div className={previewMode === 'whatsapp' && haveComposition ? 'whatsapp-bubble' : 'stage-slot'}>
            <div className={`canvas-frame ${selectedVisual && previewMode === 'studio' ? 'pannable' : ''} ${previewMode === 'whatsapp' ? 'whatsapp-sticker-frame' : ''}`}>
              <canvas width={512} height={512} ref={preview.canvas} aria-label={copy.composition} onPointerDown={event => {
                if (previewMode === 'whatsapp') { if (event.button === 0 && haveComposition) void preview.play(); return; }
                if (!selectedVisual || event.button !== 0 || preview.playing) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                draggingCanvas.current = { clientX: event.clientX, clientY: event.clientY, x: project.visual.x, y: project.visual.y };
              }} onPointerMove={event => {
                const from = draggingCanvas.current;
                if (!from) return;
                const ratio = 512 / event.currentTarget.getBoundingClientRect().width;
                const x = clamp(Math.round(from.x + (event.clientX - from.clientX) * ratio), -512, 512);
                const y = clamp(Math.round(from.y + (event.clientY - from.clientY) * ratio), -512, 512);
                change(previous => ({ ...previous, visual: { ...previous.visual, x, y } }), { group: 'pan' });
              }} onLostPointerCapture={() => { draggingCanvas.current = null; }} />
              {previewMode === 'whatsapp' && haveComposition && tracks.length > 0 && <button type="button"
                className={`sticker-sound-badge ${preview.playing ? 'playing' : ''}`}
                aria-label={preview.playing ? copy.stop : copy.tapToPlaySticker}
                onClick={() => void preview.play()}>
                {preview.playing ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>}
              {previewMode === 'whatsapp' && haveComposition && <span className="whatsapp-sticker-time" aria-hidden="true">13:10 ✓✓</span>}
              {layers.some(l => l.kind === 'text' && !project.hidden.includes(l.id)) && <p className="sr-only">{copy.readText}. {layers.flatMap(l => l.kind === 'text' && !project.hidden.includes(l.id) ? [l.style.content] : []).join('. ')}</p>}
              {!layers.length && <div className="drop-card">
                <div className="drop-icon"><ImagePlus size={27} /></div>
                <h2>{copy.studioEmptyTitle}</h2><p>{copy.studioEmptyBody}</p>
                <div className="drop-actions">
                  <button className="button button-green" disabled={Boolean(job)} onClick={() => mediaInput.current?.click()}><Upload size={17} />{copy.addMedia}</button>
                  <button className="button button-outline" disabled={Boolean(job)} onClick={() => { preview.halt(); setLibrary(true); }}><AudioLines size={17} />{copy.studioChooseSound}</button>
                </div>
                <button className="text-button example-button" disabled={Boolean(job)} onClick={demo}><Sparkles size={14} />{exampleLabel}</button>
              </div>}
            </div>
            {previewMode === 'whatsapp' && haveComposition && <div className="whatsapp-bubble-meta">
              <span>{copy.tapToPlaySticker}</span>
              <button type="button" className="button button-green button-small" onClick={() => { preview.halt(); if (gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled) { setExportFocus('whatsapp'); setExporting(true); } else setSendingWa(true); }}>
                <Send size={15} />{gwCaps?.cloudMediaEnabled && !gwCaps.whatsappBotEnabled ? copy.waCloudWhatsAppAction : copy.waSendButton}
              </button>
            </div>}
          </div>
        </div>
        <div className="studio-extras"><ThemeControl /><Wavi small level={preview.level} bass={preview.bass}
          state={job === 'recording' ? 'Listening' : job || exporting ? 'Thinking' : preview.playing ? 'Talk' : notice ? 'Confused' : 'Idle'} /></div>
      </section>
      <Inspector project={project} assets={assets} tab={tab} media={() => mediaInput.current?.click()} audio={() => audioInput.current?.click()}
        library={() => { preview.halt(); setLibrary(true); }} record={() => void record()} recording={job === 'recording'} canRecord={microphone}
        busy={Boolean(job)} change={change} select={selectVisual} remove={removeVisual} reset={resetVisual}
        track={activeTrack} selectTrack={setActiveTrack} removeTrack={removeTrack} keepTrack={keepTrack} extract={extract} />
      <section className="timeline" aria-label={copy.timeline}>
        <div className="timeline-header">
          <div className="transport">
            <button className="transport-button" aria-label={preview.playing ? copy.stop : copy.play} aria-pressed={preview.playing} disabled={!haveComposition || Boolean(job)} onClick={() => void preview.play()}>
              {preview.playing ? <Square size={14} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </button>
            <span className="timecode">{timecode(preview.position)} <span>/ {timecode(preview.duration)}</span></span>
          </div>
          <h2>{copy.timeline}</h2>
          <label className="timeline-zoom"><span>{copy.zoom}</span><input type="range" min="1" max="3" step=".25" value={timelineZoom}
            aria-label={copy.zoomTimeline} onChange={event => setTimelineZoom(event.currentTarget.valueAsNumber)} /></label>
        </div>
        <div className="timeline-body">
          <div className="track-labels"><span>{copy.duration}</span><span><ImagePlus size={15} />{copy.visualTrack}</span>
            {project.layers.map(layer => <span key={layer.id}><Layers size={15} />{layer.kind === 'text' ? copy.text : copy.media}</span>)}
            <span><AudioLines size={15} />{copy.soundTrack}</span>
            {project.tracks.map(track => <span key={track.id}><AudioLines size={15} />{copy.soundTrack}</span>)}
          </div>
          <div className="timeline-scroll">
            <div className="tracks" style={{ width: `${timelineZoom * 100}%` }}>
              <div className="timeline-ruler" aria-hidden="true">{Array.from({ length: 6 }, (_, index) =>
                <span key={index}>{(preview.duration / 5000 * index).toFixed(1)} s</span>)}</div>
              <div className="track-row">{selectedVisual || project.text.content ? <div className="track-clip visual-clip" style={clipPosition(project.visual.offset, viewLength)}>
                <span>{selectedVisual?.name ?? copy.layerText}</span>
                {visualVideo && <TrimHandles trim={project.visual.trim} source={visualVideo.duration} timeline={preview.duration}
                  disabled={Boolean(job)} edit={trim => change(previous => ({ ...previous, visual: { ...previous.visual, trim } }), { group: 'visual-trim' })} />}
              </div> : <button onClick={() => mediaInput.current?.click()} disabled={Boolean(job)}>{copy.noMedia}</button>}</div>
              {project.layers.map(layer => {
                const asset = layer.kind === 'media' ? assets.get(layer.asset) : undefined;
                const start = layer.kind === 'media' ? layer.style.offset : 0;
                const length = asset && layer.kind === 'media' && motion(asset, layer.style)
                  ? layer.style.trim.end - layer.style.trim.start : preview.duration;
                return <div className="track-row" key={layer.id}><div className="track-clip visual-clip" data-hidden={project.hidden.includes(layer.id)} style={clipPosition(start, length)}>
                  <span>{layer.kind === 'text' ? layer.style.content : asset?.name}</span>
                  {asset && layer.kind === 'media' && motion(asset, layer.style) && <TrimHandles trim={layer.style.trim} source={asset.duration} timeline={preview.duration}
                    disabled={Boolean(job)} edit={trim => change(previous => ({ ...previous, layers: previous.layers.map(item => item.kind === 'media' && item.id === layer.id ?
                      { ...item, style: { ...item.style, trim } } : item) }), { group: layer.id + 'trim' })} />}
                </div></div>;
              })}
              <div className="track-row">{selectedAudio ? <div className="track-clip audio-clip" style={clipPosition(project.sound.offset, audioLength)}>
                <Bars bars={rangedBars} /><span>{selectedAudio.name}</span>
                <TrimHandles trim={project.sound.trim} source={selectedAudio.duration} timeline={preview.duration}
                  disabled={Boolean(job)} edit={trim => change(previous => ({ ...previous, sound: { ...previous.sound, trim } }), { group: 'sound-trim' })} />
              </div> : <button onClick={() => setTab('audio')}>{copy.noAudio}</button>}</div>
              {project.tracks.map(track => {
                const asset = assets.get(track.asset);
                return asset && <div className="track-row" key={track.id}>
                  <div className="track-clip audio-clip" style={clipPosition(track.style.offset, trackDuration(track.style) - track.style.offset)}>
                    <button className="track-name-button" onClick={() => { setActiveTrack(track.id); setTab('audio'); }}>{asset.name}</button>
                    <TrimHandles trim={track.style.trim} source={asset.duration} timeline={preview.duration}
                      disabled={Boolean(job)} edit={trim => change(previous => ({ ...previous, tracks: previous.tracks.map(item => item.id === track.id ?
                        { ...item, style: { ...item.style, trim } } : item) }), { group: track.id + 'trim' })} />
                  </div>
                </div>;
              })}
              <label className="timeline-scrub"><span className="sr-only">{copy.playhead}</span><input className="scrub-range" type="range" min="0" max={preview.duration}
                step="1" value={Math.round(preview.position)} onChange={event => preview.scrub(event.currentTarget.valueAsNumber)} /></label>
              <span className="playhead" style={{ left: `${Math.min(100, preview.position / preview.duration * 100)}%` }} aria-hidden="true" />
            </div>
          </div>
        </div>
      </section>
    </div>
    {library && <Modal title={copy.catalogTitle} close={() => setLibrary(false)} className="library-modal"><SoundLibrary select={sound => void choose(sound)} /></Modal>}
    {exporting && <ExportDialog project={project} assets={assets} frame={preview.position} initialFocus={exportFocus} onOpenSendModal={() => { setExporting(false); setSendingWa(true); }} close={() => setExporting(false)} />}
    {sendingWa && <SendToWhatsAppModal project={project} assets={assets} close={() => setSendingWa(false)} onFallbackLocalExport={() => { setSendingWa(false); setExportFocus('whatsapp'); setExporting(true); }} />}
    {diagnostics && <Modal title={copy.diagnostic} close={() => setDiagnostics(false)}>
      <p>{copy.noUpload}</p>
      <dl className="capabilities">{Object.entries(capabilities()).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ? copy.supported : copy.unavailable}</dd></div>)}</dl>
      <DiagnosticLogsBox limit={30} showWhenEmpty />
      <p className="footer-credit">
        {copy.developedBy}{' '}
        <a className="credit-link" href="https://nathan-paranhos.com.br/" target="_blank" rel="noopener noreferrer">
          Nathan Paranhos (nathan-paranhos.com.br)
        </a>
      </p>
      <button className="button button-outline" onClick={() => void navigator.clipboard.writeText(JSON.stringify({
        version: '2.1.0-beta.1', capabilities: capabilities(), errors: historyRef.current.map(code => `SW-${code}`), logs: getDiagnosticLogs().slice(-50),
      }, null, 2)).then(() => { setMessage(copy.copied); setDiagnostics(false); }).catch(() => { report('4002'); setDiagnostics(false); })}>{copy.copyDiagnostic}</button>
    </Modal>}
  </div>;
}

function TrimHandles({ trim, source, timeline, disabled, edit }: { trim: Trim; source: number; timeline: number; disabled: boolean; edit: (trim: Trim) => void }) {
  const { copy } = useApp();
  const drag = useRef<{ x: number; initial: Trim; ratio: number } | null>(null);
  function pointerStart(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || disabled) return;
    const row = event.currentTarget.closest('.tracks');
    const width = row?.getBoundingClientRect().width || 0;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, initial: trim, ratio: timeline / width };
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>, edge: keyof Trim) {
    if (!drag.current) return;
    const { x, initial, ratio } = drag.current;
    const next = updateTrim(initial, edge, initial[edge] + (event.clientX - x) * ratio, source);
    if (next[edge] !== trim[edge]) edit(next);
  }
  function keyboard(event: ReactKeyboardEvent<HTMLButtonElement>, edge: keyof Trim, min: number, max: number) {
    const delta = event.shiftKey ? 500 : 100;
    const adjustments: Record<string, number> = { ArrowRight: trim[edge] + delta, ArrowUp: trim[edge] + delta,
      ArrowLeft: trim[edge] - delta, ArrowDown: trim[edge] - delta, Home: min, End: max };
    if (!Object.hasOwn(adjustments, event.key)) return;
    event.preventDefault();
    edit(updateTrim(trim, edge, adjustments[event.key], source));
  }
  return (['start', 'end'] as const).map(edge => {
    const minimum = edge === 'start' ? Math.max(0, trim.end - MAX_DURATION) : trim.start + 100;
    const maximum = edge === 'start' ? trim.end - 100 : Math.min(source, trim.start + MAX_DURATION);
    return <button key={edge} type="button" className={`trim-handle trim-${edge}`} disabled={disabled}
      role="slider" aria-label={copy[edge]} aria-valuemin={minimum / 1000} aria-valuemax={maximum / 1000} aria-valuenow={trim[edge] / 1000}
      onPointerDown={pointerStart} onPointerMove={event => pointerMove(event, edge)}
      onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => keyboard(event, edge, minimum, maximum)} />;
  });
}
