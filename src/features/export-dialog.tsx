import { useEffect, useRef, useState } from 'react';
import { Archive, AudioLines, Check, Cloud, Copy, Download, ExternalLink, Film, Image, MessageCircle, Package, Play, Share2, Square, Volume2 } from 'lucide-react';
import type { AddToWhatsAppResponse, CloudMediaFormat, GatewayCapabilitiesResponse } from '@stickerwave/contracts';
import { useApp } from '../app/context';
import { Modal, Notice } from '../app/shared';
import { imagePngExport, mp4Supported, renderExport, type ExportFormat, type ExportResult } from '../infrastructure/export';
import { addStickerToWhatsAppViaGateway, convertMediaViaCloudGateway, probeCloudGateway, renderProjectMediaForGateway } from '../infrastructure/gateway';
import { videoFormats } from '../infrastructure/media';
import { audioTracks, motion, projectDuration, visualLayers, type Project, type StoredAsset } from '../core/project';
import { errorCode, type ErrorCode } from '../locales';

type Props = {
  project: Project;
  assets: ReadonlyMap<string, StoredAsset>;
  frame: number;
  initialFocus?: 'whatsapp' | 'all';
  onOpenSendModal?: () => void;
  close: () => void;
};
type KitResult = { imageUrl: string; imageFile: File; audioUrl: string; audioFile: File };
const mimeVideo = (format: string) => format.startsWith('video/mp4') ? 'MP4' : 'WebM';

function safeBasename(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 65) || 'stickerwave';
}

export function ExportDialog({ project, assets, frame, initialFocus = 'all', onOpenSendModal, close }: Props) {
  const { copy } = useApp();
  const layers = visualLayers(project).filter(layer => !project.hidden.includes(layer.id));
  const visual = layers.length > 0;
  const sound = audioTracks(project).some(track => !track.style.muted);
  const animated = layers.some(layer => {
    const asset = layer.kind === 'media' && assets.get(layer.asset);
    return Boolean(asset && layer.kind === 'media' && motion(asset, layer.style));
  });
  const totalDuration = projectDuration(project, assets);
  const recordedContainers = [...new Set(videoFormats().map(mimeType => mimeType.split(';')[0]))];
  const containers = [...new Set([...(mp4Supported() ? ['video/mp4'] : []), ...recordedContainers])];
  const mp4Preferred = containers.find(type => type.startsWith('video/mp4')) ?? containers[0];
  const whatsappTarget: ExportFormat | null = visual
    ? (sound || animated ? (containers.length ? 'video' : 'animated-webp') : 'whatsapp-image')
    : null;
  const defaultFormat: ExportFormat = whatsappTarget ?? (sound ? 'mp3' : 'backup');

  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [progress, setProgress] = useState<number>();
  const [failure, setFailure] = useState<ErrorCode>();
  const [copiedPng, setCopiedPng] = useState(false);
  const [result, setResult] = useState<(ExportResult & { url: string; file: File; exportedFormat: ExportFormat })>();
  const [kit, setKit] = useState<KitResult>();
  const [bridgeResult, setBridgeResult] = useState<{
    response: AddToWhatsAppResponse;
    webpUrl: string;
    webpFile: File;
    oggUrl?: string;
    oggFile?: File;
  }>();
  const [thumbPreviewUrl, setThumbPreviewUrl] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [playingPreviewAudio, setPlayingPreviewAudio] = useState(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [container, setContainer] = useState(mp4Preferred);
  const [cloudCaps, setCloudCaps] = useState<GatewayCapabilitiesResponse | null>(null);
  const [showAllFormats, setShowAllFormats] = useState(initialFocus !== 'whatsapp' || !whatsappTarget);
  const operation = useRef<AbortController | null>(null);
  const objectUrls = useRef<string[]>([]);
  const previewUrlsRef = useRef<string[]>([]);
  const mounted = useRef(true);

  function clearUrls() {
    objectUrls.current.forEach(url => URL.revokeObjectURL(url));
    objectUrls.current = [];
  }

  useEffect(() => {
    mounted.current = true;
    const previewCtrl = new AbortController();
    void probeCloudGateway().then((probe) => {
      if (mounted.current && probe?.capabilities.cloudMediaEnabled) {
        setCloudCaps(probe.capabilities);
      }
    });
    if (initialFocus === 'whatsapp' && visual) {
      void imagePngExport(project, assets, previewCtrl.signal, frame)
        .then((pngBlob) => {
          if (!mounted.current) return;
          const url = URL.createObjectURL(pngBlob);
          previewUrlsRef.current.push(url);
          setThumbPreviewUrl(url);
        })
        .catch(() => undefined);
      if (sound) {
        void renderProjectMediaForGateway(project, assets, previewCtrl.signal, { skipVisual: true })
          .then((m) => {
            if (!mounted.current || !m.audioBlob) return;
            const url = URL.createObjectURL(m.audioBlob);
            previewUrlsRef.current.push(url);
            setPreviewAudioUrl(url);
          })
          .catch(() => undefined);
      }
    }
    return () => {
      mounted.current = false;
      previewCtrl.abort();
      audioElRef.current?.pause();
      operation.current?.abort(new Error('3002'));
      clearUrls();
      previewUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
      previewUrlsRef.current = [];
    };
  }, []);

  const options = [
    { id: 'webp', Icon: Image, title: copy.webp, info: visual ? copy.webpAbout : copy.needVisual, disabled: !visual },
    { id: 'wav', Icon: AudioLines, title: copy.wav, info: sound ? copy.wavAbout : copy.needAudio, disabled: !sound },
    { id: 'animated-webp', Icon: Image, title: copy.animatedWebp, info: animated ? copy.animatedWebpAbout : copy.needMotion, disabled: !animated },
    { id: 'mp3', Icon: AudioLines, title: copy.mp3, info: sound ? copy.mp3About : copy.needAudio, disabled: !sound },
    { id: 'opus', Icon: AudioLines, title: copy.opus, info: sound ? copy.opusAbout : copy.needAudio, disabled: !sound },
    { id: 'video', Icon: Film, title: copy.video, info: containers.length ? (visual ? copy.videoAbout : copy.needVisual) : copy.videoUnavailable, disabled: !visual || !containers.length },
    { id: 'wastickers', Icon: Package, title: copy.wastickers, info: visual ? copy.wastickersAbout : copy.needVisual, disabled: !visual },
    { id: 'backup', Icon: Archive, title: copy.backup, info: copy.backupAbout, disabled: false },
  ] as const;

  function mapToCloudFormat(chosenFormat: ExportFormat, chosenContainer: string): CloudMediaFormat | null {
    if (chosenFormat === 'webp' || chosenFormat === 'animated-webp') return 'webp';
    if (chosenFormat === 'opus') return 'opus';
    if (chosenFormat === 'wastickers') return 'wastickers';
    if (chosenFormat === 'video' && (!chosenContainer || chosenContainer.startsWith('video/mp4'))) return 'mp4';
    return null;
  }

  async function start(overrideFormat?: ExportFormat, overrideContainer?: string) {
    if (operation.current) return;
    const chosenFormat = overrideFormat ?? format;
    const chosenContainer = overrideContainer !== undefined ? overrideContainer : container;
    if (overrideFormat) setFormat(overrideFormat === 'whatsapp-image' ? 'webp' : overrideFormat);
    if (overrideContainer) setContainer(overrideContainer);
    const task = new AbortController();
    operation.current = task;
    clearUrls();
    setResult(undefined);
    setKit(undefined);
    setCopiedPng(false);
    setFailure(undefined);
    setProgress(0);
    try {
      const cloudFormat = cloudCaps?.cloudMediaEnabled ? mapToCloudFormat(chosenFormat, chosenContainer) : null;
      let rendered: ExportResult | null = null;

      if (cloudFormat && cloudCaps?.cloudFormats?.includes(cloudFormat)) {
        try {
          const media = await renderProjectMediaForGateway(project, assets, task.signal, {
            frameMs: frame,
            skipVisual: cloudFormat === 'opus',
          });
          if (mounted.current) setProgress(0.5);
          task.signal.throwIfAborted();
          const cloudRes = await convertMediaViaCloudGateway({
            format: cloudFormat,
            visualBlob: cloudFormat === 'opus' ? null : media.visualBlob,
            visualName: cloudFormat === 'opus' ? null : media.visualName,
            audioBlob: media.audioBlob,
            audioName: media.audioName,
            title: project.name,
            shapeOptions: {
              shape: project.stickerShape ?? 'square',
              borderWhite: Boolean(project.stickerBorder),
              background: project.background ?? null,
            },
            signal: task.signal,
          });
          rendered = { blob: cloudRes.blob, extension: cloudRes.extension };
        } catch (cloudErr) {
          if (task.signal.aborted) throw cloudErr;
          rendered = null;
        }
      }

      if (!rendered) {
        rendered = await renderExport(chosenFormat, project, assets, task.signal, value => { if (mounted.current) setProgress(value); }, frame, chosenContainer);
      }
      task.signal.throwIfAborted();
      const basename = safeBasename(project.name);
      const url = URL.createObjectURL(rendered.blob);
      objectUrls.current.push(url);
      setResult({ ...rendered, url, exportedFormat: chosenFormat, file: new File([rendered.blob], `${basename}.${rendered.extension}`, { type: rendered.blob.type }) });
    } catch (error) { if (mounted.current) setFailure(task.signal.aborted ? '3002' : errorCode(error, '3004')); }
    finally { operation.current = null; if (mounted.current) setProgress(undefined); }
  }

  async function buildWhatsappKit() {
    if (operation.current || !visual || !sound) return;
    const task = new AbortController();
    operation.current = task;
    clearUrls();
    setResult(undefined);
    setKit(undefined);
    setCopiedPng(false);
    setFailure(undefined);
    setProgress(0);
    try {
      const pngBlob = await imagePngExport(project, assets, task.signal, frame);
      if (mounted.current) setProgress(0.35);
      const mp3Res = await renderExport('mp3', project, assets, task.signal, value => { if (mounted.current) setProgress(0.35 + value * 0.65); }, frame);
      task.signal.throwIfAborted();
      const basename = safeBasename(project.name);
      const imageUrl = URL.createObjectURL(pngBlob);
      const audioUrl = URL.createObjectURL(mp3Res.blob);
      objectUrls.current.push(imageUrl, audioUrl);
      setKit({
        imageUrl,
        imageFile: new File([pngBlob], `${basename}.png`, { type: 'image/png' }),
        audioUrl,
        audioFile: new File([mp3Res.blob], `${basename}.mp3`, { type: 'audio/mpeg' }),
      });
    } catch (error) { if (mounted.current) setFailure(task.signal.aborted ? '3002' : errorCode(error, '3004')); }
    finally { operation.current = null; if (mounted.current) setProgress(undefined); }
  }

  async function copyFrameForWhatsApp() {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      setFailure('3001');
      return;
    }
    const ctrl = new AbortController();
    try {
      const png = await imagePngExport(project, assets, ctrl.signal, frame);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      if (mounted.current) { setCopiedPng(true); setFailure(undefined); }
    } catch {
      if (mounted.current) setFailure('3001');
    }
  }

  async function shareFiles(files: File[]) {
    try {
      await navigator.share({ files, title: project.name });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      try {
        await navigator.share({ files });
      } catch (fallbackError) {
        if (!(fallbackError instanceof DOMException && fallbackError.name === 'AbortError')) setFailure('3004');
      }
    }
  }

  async function runAddToWhatsAppBridge() {
    if (operation.current || !visual) return;
    if (!cloudCaps?.cloudMediaEnabled) {
      await start('wastickers', '');
      return;
    }
    const task = new AbortController();
    operation.current = task;
    clearUrls();
    setResult(undefined);
    setKit(undefined);
    setBridgeResult(undefined);
    setFailure(undefined);
    setProgress(0.15);
    try {
      const media = await renderProjectMediaForGateway(project, assets, task.signal, { frameMs: frame });
      if (mounted.current) setProgress(0.55);
      const res = await addStickerToWhatsAppViaGateway({
        visualBlob: media.visualBlob,
        visualName: media.visualName,
        audioBlob: media.audioBlob,
        audioName: media.audioName,
        packName: project.name,
        shapeOptions: {
          shape: project.stickerShape ?? 'square',
          borderWhite: Boolean(project.stickerBorder),
          background: project.background ?? null,
        },
        signal: task.signal,
      });
      task.signal.throwIfAborted();
      const basename = safeBasename(project.name);
      const webpB64 = res.encodedSticker?.webpBase64;
      if (!webpB64) throw new Error('3004');
      const webpBytes = Uint8Array.from(atob(webpB64), (c) => c.charCodeAt(0));
      const webpBlob = new Blob([webpBytes], { type: 'image/webp' });
      const webpUrl = URL.createObjectURL(webpBlob);
      objectUrls.current.push(webpUrl);
      const webpFile = new File([webpBlob], `${basename}.webp`, { type: 'image/webp' });

      let oggUrl: string | undefined;
      let oggFile: File | undefined;
      if (res.encodedSticker?.oggBase64) {
        const oggBytes = Uint8Array.from(atob(res.encodedSticker.oggBase64), (c) => c.charCodeAt(0));
        const oggBlob = new Blob([oggBytes], { type: 'audio/ogg' });
        oggUrl = URL.createObjectURL(oggBlob);
        objectUrls.current.push(oggUrl);
        oggFile = new File([oggBlob], `${basename}.ogg`, { type: 'audio/ogg' });
      }
      if (mounted.current) {
        setBridgeResult({ response: res, webpUrl, webpFile, oggUrl, oggFile });
      }
    } catch (error) {
      if (mounted.current) setFailure(task.signal.aborted ? '3002' : errorCode(error, '3004'));
    } finally {
      operation.current = null;
      if (mounted.current) setProgress(undefined);
    }
  }

  function toggleBridgeAudio() {
    if (!previewAudioUrl) return;
    if (playingPreviewAudio && audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
      setPlayingPreviewAudio(false);
      return;
    }
    const audio = audioElRef.current ?? new Audio(previewAudioUrl);
    audio.src = previewAudioUrl;
    audio.onended = () => setPlayingPreviewAudio(false);
    audioElRef.current = audio;
    void audio.play().then(() => setPlayingPreviewAudio(true)).catch(() => setPlayingPreviewAudio(false));
  }

  const shareable = result && navigator.canShare?.({ files: [result.file] });
  const kitShareable = kit && navigator.canShare?.({ files: [kit.imageFile, kit.audioFile] });
  const bridgeShareable = bridgeResult && navigator.canShare?.({ files: [bridgeResult.webpFile] });
  const canClipboardImage = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write) && visual;
  const isWhatsappMedia = result && ['video', 'webp', 'animated-webp', 'whatsapp-image', 'wastickers'].includes(result.exportedFormat);
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const hasOutput = Boolean(result || kit || bridgeResult);
  const stickerTypeLabel = sound
    ? copy.stickerTypeSound
    : animated
      ? copy.stickerTypeAnimated
      : copy.stickerTypeStatic;

  return <Modal title={copy.exportTitle} className="export-modal" close={() => operation.current ? operation.current.abort(new Error('3002')) : close()}>
    {!hasOutput && cloudCaps?.cloudMediaEnabled && <span className="wa-cloud-pill">
      <Cloud size={14} />
      {copy.waCloudBadge}
    </span>}

    {!hasOutput && initialFocus === 'whatsapp' && whatsappTarget && <div className="wa-conclusion-card">
      <div className="wa-conclusion-top">
        {thumbPreviewUrl && <img className="wa-conclusion-thumb" src={thumbPreviewUrl} width={72} height={72} alt={copy.preview} />}
        <div className="wa-conclusion-meta">
          <div className="wa-conclusion-badges">
            <span className="wa-type-pill"><Volume2 size={13} />{stickerTypeLabel}</span>
            <span className="wa-compat-badge">{(totalDuration / 1000).toFixed(1)} s</span>
            <span className="wa-compat-badge"><Check size={13} />{copy.stickerCompatReady}</span>
          </div>
          {previewAudioUrl && <button type="button" className="button button-outline button-small" onClick={toggleBridgeAudio}>
            {playingPreviewAudio ? <Square size={13} /> : <Play size={13} />}
            {playingPreviewAudio ? copy.waSendStopAudio : copy.waSendPlayAudio}
          </button>}
        </div>
      </div>
    </div>}

    {!hasOutput && whatsappTarget && <div className="whatsapp-direct-box">
      <div className="whatsapp-direct-copy">
        <strong><MessageCircle size={17} />{copy.whatsappDirectTitle}</strong>
        <p>{copy.whatsappDirectBody}</p>
      </div>
      <div className="whatsapp-direct-actions">
        <button type="button" className="button button-green" disabled={progress !== undefined}
          onClick={() => void runAddToWhatsAppBridge()}>
          <MessageCircle size={17} />{copy.addToWhatsAppAction}
        </button>
        {onOpenSendModal && <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={onOpenSendModal}>
          <ExternalLink size={16} />{copy.sendThroughWhatsAppAction}
        </button>}
        <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void start('wastickers', '')}>
          <Package size={16} />{copy.whatsappWastickersAction}
        </button>
        <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void start(whatsappTarget, whatsappTarget === 'video' ? mp4Preferred : '')}>
          <Film size={16} />{sound || animated ? copy.whatsappDirectAction : copy.whatsappWastickersAction}
        </button>
        {sound && <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void buildWhatsappKit()}>
          <AudioLines size={16} />{copy.whatsappKitAction}
        </button>}
        {canClipboardImage && <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void copyFrameForWhatsApp()}>
          {copiedPng ? <Check size={16} /> : <Copy size={16} />}
          {copiedPng ? copy.whatsappCopiedImage : copy.whatsappCopyImage}
        </button>}
      </div>
      {copiedPng && sound && <p className="inspector-note">{copy.whatsappCopyFrameNote}</p>}
    </div>}

    {!hasOutput && whatsappTarget && <button type="button" className="text-button" onClick={() => setShowAllFormats(v => !v)}>
      {showAllFormats ? copy.whatsappHideAllFormats : copy.whatsappShowAllFormats}
    </button>}

    {!hasOutput && showAllFormats && <fieldset className="format-options">
      <legend>{copy.format}</legend>
      {options.map(({ id, Icon, title, info, disabled }) => <label key={id} className={`format-option ${format === id ? 'format-selected' : ''}`}>
        <input type="radio" name="format" value={id} checked={format === id} disabled={disabled || progress !== undefined} onChange={() => setFormat(id)} />
        <Icon size={21} /><span><strong>{title}</strong><small>{info}</small></span>
      </label>)}
    </fieldset>}
    {!hasOutput && showAllFormats && format === 'video' && !!containers.length && <><div className="segmented format-containers">
      {containers.map(item => <button key={item} disabled={progress !== undefined} aria-pressed={container === item} onClick={() => setContainer(item)}>{mimeVideo(item)}</button>)}
    </div><p className="inspector-note">{copy.native}</p></>}
    {failure && <Notice error={failure !== '3002'}>{copy.errors[failure]} [SW-{failure}]</Notice>}
    {progress !== undefined && <div className="progress-area" role="status"><p>{copy.exporting}</p><progress value={progress || undefined} max={1} /></div>}

    {bridgeResult && <div className="export-result" role="status">
      <h3>{bridgeResult.response.headline}</h3>
      <p>{bridgeResult.response.explanation}</p>
      <img src={bridgeResult.webpUrl} width="128" height="128" alt={copy.preview} />
      {bridgeResult.response.encodedSticker && <p className="inspector-note">
        WebP {(bridgeResult.response.encodedSticker.webpBytes / 1024).toFixed(1)} KB
        {bridgeResult.response.encodedSticker.oggBytes > 0 ? ` · Ogg/Opus ${(bridgeResult.response.encodedSticker.oggBytes / 1024).toFixed(1)} KB` : ''}
      </p>}
      <div className="button-row">
        {onOpenSendModal && <button type="button" className="button button-green" onClick={onOpenSendModal}>
          <MessageCircle size={17} />{copy.sendThroughWhatsAppAction}
        </button>}
        {bridgeShareable && <button type="button" className="button button-green" onClick={() => void shareFiles([bridgeResult.webpFile])}>
          <Share2 size={17} />{copy.whatsappSendDirect}
        </button>}
        <a className="button button-outline" href={bridgeResult.webpUrl} download={bridgeResult.webpFile.name}><Download size={17} />{copy.downloadWebpExifAction}</a>
        {bridgeResult.oggUrl && bridgeResult.oggFile && <a className="button button-outline" href={bridgeResult.oggUrl} download={bridgeResult.oggFile.name}><Download size={17} />Ogg/Opus</a>}
      </div>
      <details className="wa-secondary-exports">
        <summary>{copy.waBridgeSecondaryFormats}</summary>
        <div className="button-row" style={{ marginTop: 8 }}>
          <button type="button" className="button button-outline button-small" onClick={() => { setBridgeResult(undefined); void start(whatsappTarget ?? 'webp', whatsappTarget === 'video' ? mp4Preferred : ''); }}>
            <Film size={15} />{copy.whatsappDirectAction}
          </button>
          <button type="button" className="button button-outline button-small" onClick={() => { setBridgeResult(undefined); void start('wastickers', ''); }}>
            <Package size={15} />{copy.whatsappWastickersAction}
          </button>
        </div>
      </details>
      <button className="text-button" onClick={() => setBridgeResult(undefined)}>{copy.format}</button>
    </div>}

    {kit && <div className="export-result" role="status">
      <h3>{copy.whatsappKitTitle}</h3>
      <p>{kit.imageFile.name} · {(kit.imageFile.size / 1024).toFixed(1)} KB + {kit.audioFile.name} · {(kit.audioFile.size / 1024).toFixed(1)} KB</p>
      <img src={kit.imageUrl} width="128" height="128" alt={copy.preview} />
      <div className="button-row">
        {kitShareable && <button type="button" className="button button-green" onClick={() => void shareFiles([kit.imageFile, kit.audioFile])}>
          <Share2 size={17} />{copy.whatsappKitShareBoth}
        </button>}
        <a className={kitShareable ? 'button button-outline' : 'button button-green'} href={kit.imageUrl} download={kit.imageFile.name}><Download size={17} />{copy.whatsappKitDownloadImg}</a>
        <a className={kitShareable ? 'button button-outline' : 'button button-green'} href={kit.audioUrl} download={kit.audioFile.name}><Download size={17} />{copy.whatsappKitDownloadAudio}</a>
        <a className="button button-outline" href="https://api.whatsapp.com/send" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenApp}
        </a>
      </div>
      <details className="whatsapp-guide-details">
        <summary>{copy.whatsappQuickTipsToggle}</summary>
        <div className="whatsapp-guide">
          <p>{copy.whatsappStep1}</p>
          <p>{copy.whatsappStep2}</p>
          <p>{copy.whatsappStep3}</p>
        </div>
      </details>
      <button className="text-button" onClick={() => setKit(undefined)}>{copy.format}</button>
    </div>}

    {result && <div className="export-result" role="status"><h3>{copy.exportDone}</h3><p>{result.file.name} · {(result.blob.size / 1024).toFixed(1)} KB</p>
      {(result.extension === 'webp' || result.extension === 'png') && <img src={result.url} width="128" height="128" alt={copy.preview} />}
      {result.extension === 'mp4' && <video className="export-video-preview" src={result.url} width="200" height="200" controls playsInline loop />}
      {result.exportedFormat === 'webp' && result.extension === 'webp' && result.blob.size > 100 * 1024 && <p>{copy.sizeWarning}</p>}
      {result.exportedFormat === 'video' && sound && totalDuration > 5000 && <Notice>{copy.whatsappDurationNote}</Notice>}
      <div className="button-row">
        {shareable && <button type="button" className="button button-green" onClick={() => void shareFiles([result.file])}>
          <Share2 size={17} />{copy.whatsappSendDirect}
        </button>}
        <a className={shareable ? 'button button-outline' : 'button button-green'} href={result.url} download={result.file.name}><Download size={18} />{copy.download}</a>
        {isWhatsappMedia && !isMobile && <a className="button button-outline" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenWeb}
        </a>}
        {isWhatsappMedia && canClipboardImage && <button type="button" className="button button-outline" onClick={() => void copyFrameForWhatsApp()}>
          {copiedPng ? <Check size={16} /> : <Copy size={16} />}
          {copiedPng ? copy.whatsappCopiedImage : copy.whatsappCopyImage}
        </button>}
      </div>
      {isWhatsappMedia && <details className="whatsapp-guide-details">
        <summary>{copy.whatsappQuickTipsToggle}</summary>
        <div className="whatsapp-guide">
          <p>{copy.whatsappStep1}</p>
          <p>{copy.whatsappStep2}</p>
          <p>{copy.whatsappStep3}</p>
        </div>
      </details>}
      <button className="text-button" onClick={() => setResult(undefined)}>{copy.format}</button>
    </div>}

    {!hasOutput && <div className="button-row modal-actions">
      {progress !== undefined ? <button className="button button-outline" onClick={() => operation.current?.abort(new Error('3002'))}>{copy.cancelExport}</button>
        : <><button className="button button-outline" onClick={close}>{copy.cancel}</button>
          {showAllFormats && <button className="button button-green" disabled={options.find(option => option.id === format)?.disabled} onClick={() => void start()}><Download size={18} />{copy.export}</button>}</>}
    </div>}
  </Modal>;
}