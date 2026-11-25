import { useEffect, useRef, useState } from 'react';
import { Archive, AudioLines, Check, Copy, Download, ExternalLink, Film, Image, MessageCircle, Share2 } from 'lucide-react';
import { useApp } from '../app/context';
import { Modal, Notice } from '../app/shared';
import { imagePngExport, renderExport, type ExportFormat, type ExportResult } from '../infrastructure/export';
import { videoFormats } from '../infrastructure/media';
import { audioTracks, motion, visualLayers, type Project, type StoredAsset } from '../core/project';
import { errorCode, type ErrorCode } from '../locales';

type Props = { project: Project; assets: ReadonlyMap<string, StoredAsset>; frame: number; close: () => void };
const mimeVideo = (format: string) => format.startsWith('video/mp4') ? 'MP4' : 'WebM';

export function ExportDialog({ project, assets, frame, close }: Props) {
  const { copy } = useApp();
  const layers = visualLayers(project).filter(layer => !project.hidden.includes(layer.id));
  const visual = layers.length > 0;
  const sound = audioTracks(project).length > 0;
  const animated = layers.some(layer => {
    const asset = layer.kind === 'media' && assets.get(layer.asset);
    return Boolean(asset && layer.kind === 'media' && motion(asset, layer.style));
  });
  const containers = [...new Set(videoFormats().map(mimeType => mimeType.split(';')[0]))];
  const mp4Preferred = containers.find(type => type.startsWith('video/mp4')) ?? containers[0];
  const whatsappTarget: ExportFormat | null = visual
    ? (sound && containers.length ? 'video' : animated ? 'animated-webp' : 'webp')
    : null;
  const defaultFormat: ExportFormat = whatsappTarget ?? (sound ? 'wav' : 'backup');

  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [progress, setProgress] = useState<number>();
  const [failure, setFailure] = useState<ErrorCode>();
  const [copiedPng, setCopiedPng] = useState(false);
  const [result, setResult] = useState<(ExportResult & { url: string; file: File; exportedFormat: ExportFormat })>();
  const [container, setContainer] = useState(mp4Preferred);
  const operation = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort(new Error('3002'));
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);
  const options = [
    { id: 'webp', Icon: Image, title: copy.webp, info: visual ? copy.webpAbout : copy.needVisual, disabled: !visual },
    { id: 'wav', Icon: AudioLines, title: copy.wav, info: sound ? copy.wavAbout : copy.needAudio, disabled: !sound },
    { id: 'animated-webp', Icon: Image, title: copy.animatedWebp, info: animated ? copy.animatedWebpAbout : copy.needMotion, disabled: !animated },
    { id: 'opus', Icon: AudioLines, title: copy.opus, info: sound ? copy.opusAbout : copy.needAudio, disabled: !sound },
    { id: 'video', Icon: Film, title: copy.video, info: containers.length ? (visual ? copy.videoAbout : copy.needVisual) : copy.videoUnavailable, disabled: !visual || !containers.length },
    { id: 'backup', Icon: Archive, title: copy.backup, info: copy.backupAbout, disabled: false },
  ] as const;

  async function start(overrideFormat?: ExportFormat, overrideContainer?: string) {
    if (operation.current) return;
    const chosenFormat = overrideFormat ?? format;
    const chosenContainer = overrideContainer ?? container;
    if (overrideFormat) setFormat(overrideFormat === 'whatsapp-image' ? 'webp' : overrideFormat);
    if (overrideContainer) setContainer(overrideContainer);
    const task = new AbortController();
    operation.current = task;
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = undefined; }
    setResult(undefined);
    setCopiedPng(false);
    setFailure(undefined);
    setProgress(0);
    try {
      const rendered = await renderExport(chosenFormat, project, assets, task.signal, value => { if (mounted.current) setProgress(value); }, frame, chosenContainer);
      task.signal.throwIfAborted();
      const basename = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 65) || 'stickerwave';
      const url = URL.createObjectURL(rendered.blob);
      objectUrl.current = url;
      setResult({ ...rendered, url, exportedFormat: chosenFormat, file: new File([rendered.blob], `${basename}.${rendered.extension}`, { type: rendered.blob.type }) });
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

  const shareable = result && navigator.canShare?.({ files: [result.file] });
  const canClipboardImage = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write) && visual;
  const isWhatsappMedia = result && (result.exportedFormat === 'video' || result.exportedFormat === 'webp' || result.exportedFormat === 'animated-webp' || result.exportedFormat === 'whatsapp-image');
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  async function shareToWhatsapp() {
    if (!result) return;
    try {
      await navigator.share({ files: [result.file], title: project.name });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      try {
        await navigator.share({ files: [result.file] });
      } catch (fallbackError) {
        if (!(fallbackError instanceof DOMException && fallbackError.name === 'AbortError')) setFailure('3004');
      }
    }
  }

  return <Modal title={copy.exportTitle} className="export-modal" close={() => operation.current ? operation.current.abort(new Error('3002')) : close()}>
    {!result && whatsappTarget && <div className="whatsapp-direct-box">
      <div className="whatsapp-direct-copy">
        <strong><MessageCircle size={17} />{copy.whatsappDirectTitle}</strong>
        <p>{copy.whatsappDirectBody}</p>
      </div>
      <button type="button" className="button button-green" disabled={progress !== undefined}
        onClick={() => void start(whatsappTarget === 'webp' ? 'whatsapp-image' : whatsappTarget, '')}>
        <MessageCircle size={17} />{copy.whatsappDirectAction}
      </button>
    </div>}

    {!result && <fieldset className="format-options">
      <legend>{copy.format}</legend>
      {options.map(({ id, Icon, title, info, disabled }) => <label key={id} className={`format-option ${format === id ? 'format-selected' : ''}`}>
        <input type="radio" name="format" value={id} checked={format === id} disabled={disabled || progress !== undefined} onChange={() => setFormat(id)} />
        <Icon size={21} /><span><strong>{title}</strong><small>{info}</small></span>
      </label>)}
    </fieldset>}
    {!result && format === 'video' && !!containers.length && <><div className="segmented format-containers">
      {containers.map(item => <button key={item} disabled={progress !== undefined} aria-pressed={container === item} onClick={() => setContainer(item)}>{mimeVideo(item)}</button>)}
    </div><p className="inspector-note">{copy.native}</p></>}
    {failure && <Notice error={failure !== '3002'}>{copy.errors[failure]} [SW-{failure}]</Notice>}
    {progress !== undefined && <div className="progress-area" role="status"><p>{copy.exporting}</p><progress value={progress || undefined} max={1} /></div>}
    {result && <div className="export-result" role="status"><h3>{copy.exportDone}</h3><p>{result.file.name} · {(result.blob.size / 1024).toFixed(1)} KB</p>
      {(result.extension === 'webp' || result.extension === 'png') && <img src={result.url} width="128" height="128" alt={copy.preview} />}
      {(result.exportedFormat === 'webp' || result.exportedFormat === 'whatsapp-image') && result.extension === 'webp' && result.blob.size > 100 * 1024 && <p>{copy.sizeWarning}</p>}
      <div className="button-row">
        {shareable && <button type="button" className="button button-green" onClick={() => void shareToWhatsapp()}>
          <Share2 size={17} />{copy.whatsappSendDirect}
        </button>}
        <a className={`button ${shareable ? 'button-outline' : 'button-green'}`} href={result.url} download={result.file.name}><Download size={18} />{copy.download}</a>
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
    {!result && <div className="button-row modal-actions">
      {progress !== undefined ? <button className="button button-outline" onClick={() => operation.current?.abort(new Error('3002'))}>{copy.cancelExport}</button>
        : <><button className="button button-outline" onClick={close}>{copy.cancel}</button>
          <button className="button button-green" disabled={options.find(option => option.id === format)?.disabled} onClick={() => void start()}><Download size={18} />{copy.export}</button></>}
    </div>}
  </Modal>;
}
