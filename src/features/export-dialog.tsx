import { useEffect, useRef, useState } from 'react';
import { Archive, AudioLines, Check, Copy, Download, ExternalLink, Film, Image, MessageCircle, Package, Share2 } from 'lucide-react';
import { useApp } from '../app/context';
import { Modal, Notice } from '../app/shared';
import { imagePngExport, mp4Supported, renderExport, type ExportFormat, type ExportResult } from '../infrastructure/export';
import { videoFormats } from '../infrastructure/media';
import { audioTracks, motion, projectDuration, visualLayers, type Project, type StoredAsset } from '../core/project';
import { errorCode, type ErrorCode } from '../locales';

type Props = { project: Project; assets: ReadonlyMap<string, StoredAsset>; frame: number; close: () => void };
type KitResult = { imageUrl: string; imageFile: File; audioUrl: string; audioFile: File };
const mimeVideo = (format: string) => format.startsWith('video/mp4') ? 'MP4' : 'WebM';

function safeBasename(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 65) || 'stickerwave';
}

export function ExportDialog({ project, assets, frame, close }: Props) {
  const { copy } = useApp();
  const layers = visualLayers(project).filter(layer => !project.hidden.includes(layer.id));
  const visual = layers.length > 0;
  const sound = audioTracks(project).length > 0;
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
  const [container, setContainer] = useState(mp4Preferred);
  const operation = useRef<AbortController | null>(null);
  const objectUrls = useRef<string[]>([]);
  const mounted = useRef(true);

  function clearUrls() {
    objectUrls.current.forEach(url => URL.revokeObjectURL(url));
    objectUrls.current = [];
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort(new Error('3002'));
      clearUrls();
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
      const rendered = await renderExport(chosenFormat, project, assets, task.signal, value => { if (mounted.current) setProgress(value); }, frame, chosenContainer);
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

  const shareable = result && navigator.canShare?.({ files: [result.file] });
  const kitShareable = kit && navigator.canShare?.({ files: [kit.imageFile, kit.audioFile] });
  const canClipboardImage = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write) && visual;
  const isWhatsappMedia = result && ['video', 'webp', 'animated-webp', 'whatsapp-image', 'wastickers'].includes(result.exportedFormat);
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const hasOutput = Boolean(result || kit);

  return <Modal title={copy.exportTitle} className="export-modal" close={() => operation.current ? operation.current.abort(new Error('3002')) : close()}>
    {!hasOutput && whatsappTarget && <div className="whatsapp-direct-box">
      <div className="whatsapp-direct-copy">
        <strong><MessageCircle size={17} />{copy.whatsappDirectTitle}</strong>
        <p>{copy.whatsappDirectBody}</p>
      </div>
      <div className="whatsapp-direct-actions">
        <button type="button" className="button button-green" disabled={progress !== undefined}
          onClick={() => void start(whatsappTarget, whatsappTarget === 'video' ? mp4Preferred : '')}>
          <MessageCircle size={17} />{copy.whatsappDirectAction}
        </button>
        {sound && <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void buildWhatsappKit()}>
          <AudioLines size={16} />{copy.whatsappKitAction}
        </button>}
        <button type="button" className="button button-outline" disabled={progress !== undefined}
          onClick={() => void start('wastickers', '')}>
          <Package size={16} />{copy.whatsappWastickersAction}
        </button>
      </div>
    </div>}

    {!hasOutput && <fieldset className="format-options">
      <legend>{copy.format}</legend>
      {options.map(({ id, Icon, title, info, disabled }) => <label key={id} className={`format-option ${format === id ? 'format-selected' : ''}`}>
        <input type="radio" name="format" value={id} checked={format === id} disabled={disabled || progress !== undefined} onChange={() => setFormat(id)} />
        <Icon size={21} /><span><strong>{title}</strong><small>{info}</small></span>
      </label>)}
    </fieldset>}
    {!hasOutput && format === 'video' && !!containers.length && <><div className="segmented format-containers">
      {containers.map(item => <button key={item} disabled={progress !== undefined} aria-pressed={container === item} onClick={() => setContainer(item)}>{mimeVideo(item)}</button>)}
    </div><p className="inspector-note">{copy.native}</p></>}
    {failure && <Notice error={failure !== '3002'}>{copy.errors[failure]} [SW-{failure}]</Notice>}
    {progress !== undefined && <div className="progress-area" role="status"><p>{copy.exporting}</p><progress value={progress || undefined} max={1} /></div>}

    {kit && <div className="export-result" role="status">
      <h3>{copy.whatsappKitTitle}</h3>
      <p>{kit.imageFile.name} · {(kit.imageFile.size / 1024).toFixed(1)} KB + {kit.audioFile.name} · {(kit.audioFile.size / 1024).toFixed(1)} KB</p>
      <img src={kit.imageUrl} width="128" height="128" alt={copy.preview} />
      <div className="button-row">
        <a className="button button-green" href={kit.imageUrl} download={kit.imageFile.name}><Download size={17} />{copy.whatsappKitDownloadImg}</a>
        <a className="button button-green" href={kit.audioUrl} download={kit.audioFile.name}><Download size={17} />{copy.whatsappKitDownloadAudio}</a>
        {kitShareable && <button type="button" className="button button-outline" onClick={() => void shareFiles([kit.imageFile, kit.audioFile])}>
          <Share2 size={17} />{copy.whatsappKitShareBoth}
        </button>}
        <a className="button button-outline" href="https://api.whatsapp.com/send" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenApp}
        </a>
        {!isMobile && <a className="button button-outline" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenWeb}
        </a>}
        {canClipboardImage && <button type="button" className="button button-outline" onClick={() => void copyFrameForWhatsApp()}>
          {copiedPng ? <Check size={16} /> : <Copy size={16} />}
          {copiedPng ? copy.whatsappCopiedImage : copy.whatsappCopyImage}
        </button>}
      </div>
      <div className="whatsapp-guide">
        <strong>{copy.whatsappStepsTitle}</strong>
        <p>{copy.whatsappStep1}</p>
        <p>{copy.whatsappStep2}</p>
        <p>{copy.whatsappStep3}</p>
      </div>
      <button className="text-button" onClick={() => setKit(undefined)}>{copy.format}</button>
    </div>}

    {result && <div className="export-result" role="status"><h3>{copy.exportDone}</h3><p>{result.file.name} · {(result.blob.size / 1024).toFixed(1)} KB</p>
      {(result.extension === 'webp' || result.extension === 'png') && <img src={result.url} width="128" height="128" alt={copy.preview} />}
      {result.exportedFormat === 'webp' && result.extension === 'webp' && result.blob.size > 100 * 1024 && <p>{copy.sizeWarning}</p>}
      {result.exportedFormat === 'video' && sound && totalDuration > 5000 && <Notice>{copy.whatsappDurationNote}</Notice>}
      <div className="button-row">
        <a className="button button-green" href={result.url} download={result.file.name}><Download size={18} />{copy.download}</a>
        {shareable && <button type="button" className="button button-outline" onClick={() => void shareFiles([result.file])}>
          <Share2 size={17} />{copy.whatsappSendDirect}
        </button>}
        {isWhatsappMedia && visual && sound && <button type="button" className="button button-outline" disabled={progress !== undefined} onClick={() => void buildWhatsappKit()}>
          <AudioLines size={16} />{copy.whatsappKitAction}
        </button>}
        {isWhatsappMedia && result.exportedFormat !== 'wastickers' && <button type="button" className="button button-outline" disabled={progress !== undefined} onClick={() => void start('wastickers', '')}>
          <Package size={16} />{copy.whatsappWastickersAction}
        </button>}
        {isWhatsappMedia && <a className="button button-outline" href="https://api.whatsapp.com/send" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenApp}
        </a>}
        {isWhatsappMedia && !isMobile && <a className="button button-outline" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} />{copy.whatsappOpenWeb}
        </a>}
        {isWhatsappMedia && canClipboardImage && <button type="button" className="button button-outline" onClick={() => void copyFrameForWhatsApp()}>
          {copiedPng ? <Check size={16} /> : <Copy size={16} />}
          {copiedPng ? copy.whatsappCopiedImage : copy.whatsappCopyImage}
        </button>}
      </div>
      {isWhatsappMedia && <div className="whatsapp-guide">
        <strong>{copy.whatsappStepsTitle}</strong>
        <p>{copy.whatsappStep1}</p>
        <p>{copy.whatsappStep2}</p>
        <p>{copy.whatsappStep3}</p>
        {sound && result.exportedFormat !== 'video' && <p>{copy.whatsappCopyFrameNote}</p>}
      </div>}
      <button className="text-button" onClick={() => setResult(undefined)}>{copy.format}</button>
    </div>}

    {!hasOutput && <div className="button-row modal-actions">
      {progress !== undefined ? <button className="button button-outline" onClick={() => operation.current?.abort(new Error('3002'))}>{copy.cancelExport}</button>
        : <><button className="button button-outline" onClick={close}>{copy.cancel}</button>
          <button className="button button-green" disabled={options.find(option => option.id === format)?.disabled} onClick={() => void start()}><Download size={18} />{copy.export}</button></>}
    </div>}
  </Modal>;
}