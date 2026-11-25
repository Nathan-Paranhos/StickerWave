import { useEffect, useRef, useState } from 'react';
import { Archive, AudioLines, Download, Film, Image, Share2 } from 'lucide-react';
import { useApp } from '../app/context';
import { Modal, Notice } from '../app/shared';
import { renderExport, type ExportFormat, type ExportResult } from '../infrastructure/export';
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
  const [format, setFormat] = useState<ExportFormat>(visual ? 'webp' : sound ? 'wav' : 'backup');
  const [progress, setProgress] = useState<number>();
  const [failure, setFailure] = useState<ErrorCode>();
  const [result, setResult] = useState<(ExportResult & { url: string; file: File })>();
  const containers = [...new Set(videoFormats().map(mimeType => mimeType.split(';')[0]))];
  const [container, setContainer] = useState(containers[0]);
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

  async function start() {
    if (operation.current) return;
    const task = new AbortController();
    operation.current = task;
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = undefined; }
    setResult(undefined);
    setFailure(undefined);
    setProgress(0);
    try {
      const result = await renderExport(format, project, assets, task.signal, value => { if (mounted.current) setProgress(value); }, frame, container);
      task.signal.throwIfAborted();
      const basename = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 65) || 'stickerwave';
      const url = URL.createObjectURL(result.blob);
      objectUrl.current = url;
      setResult({ ...result, url, file: new File([result.blob], `${basename}.${result.extension}`, { type: result.blob.type }) });
    } catch (error) { if (mounted.current) setFailure(task.signal.aborted ? '3002' : errorCode(error, '3004')); }
    finally { operation.current = null; if (mounted.current) setProgress(undefined); }
  }
  const shareable = result && navigator.canShare?.({ files: [result.file] });
  return <Modal title={copy.exportTitle} className="export-modal" close={() => operation.current ? operation.current.abort(new Error('3002')) : close()}>
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
      {result.extension === 'webp' && <img src={result.url} width="128" height="128" alt={copy.preview} />}
      {format === 'webp' && result.blob.size > 100 * 1024 && <p>{copy.sizeWarning}</p>}
      <div className="button-row">
        <a className="button button-green" href={result.url} download={result.file.name}><Download size={18} />{copy.download}</a>
        {shareable && <button className="button button-outline" onClick={() => void navigator.share({ files: [result.file] })
          .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) setFailure('3004'); })}><Share2 size={17} />{copy.share}</button>}
      </div>
      {format === 'video' && <div className="whatsapp-guide">
        <strong>{copy.whatsappStepsTitle}</strong>
        <p>{copy.whatsappStep1}</p>
        <p>{copy.whatsappStep2}</p>
        <p>{copy.whatsappStep3}</p>
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
