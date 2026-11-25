import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, AudioLines, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Headphones, ImagePlus, Layers, Mic, RotateCcw, Save, Square, Trash2, Type, Upload } from 'lucide-react';
import { useApp } from '../app/context';
import {
  audioTracks, clamp, initialText, initialVisual, MAX_LAYERS, motion, newTrim, stickerShapes, updateTrim, visualLayers,
  type Layer, type Project, type SoundStyle, type StoredAsset, type TextStyle, type Trim, type VisualStyle,
} from '../core/project';

export type Tab = 'media' | 'text' | 'audio' | 'layers';
type Props = {
  project: Project; assets: ReadonlyMap<string, StoredAsset>; tab: Tab;
  media: () => void; audio: () => void; library: () => void; record: () => void; extract: () => void;
  recording: boolean; canRecord: boolean; busy: boolean;
  track: string; selectTrack: (id: string) => void; removeTrack: (id: string) => void; keepTrack: (asset: StoredAsset) => void;
  change: (update: (project: Project) => Project, options?: { group?: string }) => void;
  select: (asset: StoredAsset) => void; remove: (id: string) => void; reset: () => void;
};

export function Slider({ label, value, onChange, min = 0, max = 100, step = 1, units = '', numeric = false }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; units?: string; numeric?: boolean;
}) {
  const { copy } = useApp();
  return <div className="slider-field"><label><span>{label}<output>{value}{units}</output></span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={event => onChange(event.currentTarget.valueAsNumber)} />
  </label>{numeric && <input className="slider-number" type="number" min={min} max={max} step={step}
    aria-label={`${copy.label} · ${label}`} key={value} defaultValue={value} onBlur={event => {
      if (Number.isFinite(event.currentTarget.valueAsNumber)) onChange(clamp(Number((min + Math.round((event.currentTarget.valueAsNumber - min) / step) * step).toFixed(4)), min, max));
    }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />}</div>;
}

export function TimeField({ label, value, min, max, change }: { label: string; value: number; min: number; max: number; change: (value: number) => void }) {
  return <label className="number-field">{label}<input type="number" min={min / 1000} max={max / 1000} step=".01"
    defaultValue={(value / 1000).toFixed(2)} key={value}
    onBlur={event => {
      const next = event.currentTarget.valueAsNumber;
      if (Number.isFinite(next)) change(clamp(Math.round(next * 1000), min, max));
      event.currentTarget.value = (clamp(next * 1000 || 0, min, max) / 1000).toFixed(2);
    }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}
function TrimControl({ trim, duration, set }: { trim: Trim; duration: number; set: (edge: keyof Trim, value: number) => void }) {
  const { copy } = useApp();
  return <fieldset className="trim-fields"><legend>{copy.trim}</legend><div>
    <TimeField label={copy.start} value={trim.start} min={Math.max(0, trim.end - 10000)} max={trim.end - 100} change={value => set('start', value)} />
    <TimeField label={copy.end} value={trim.end} min={trim.start + 100} max={Math.min(trim.start + 10000, duration)} change={value => set('end', value)} />
  </div></fieldset>;
}
function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <section className="inspector-group"><h3>{title}</h3>{children}</section>;
}
type UpdateStyle<T> = <K extends keyof T>(key: K, value: T[K]) => void;

function VisualPanel({ visual, asset, update, reset }: {
  visual: VisualStyle; asset: StoredAsset; update: UpdateStyle<VisualStyle>; reset: () => void;
}) {
  const { copy } = useApp();
  return <>
    <Group title={copy.framing}>
      <div className="segmented">{(['contain', 'cover'] as const).map(fit =>
        <button key={fit} aria-pressed={visual.fit === fit} onClick={() => update('fit', fit)}>{copy[fit]}</button>)}</div>
      <Slider label={copy.zoom} min={25} max={400} value={Math.round(visual.zoom * 100)} units="%" onChange={value => update('zoom', value / 100)} />
      <Slider label={copy.crop} min={0} max={45} value={visual.crop} units="%" onChange={value => update('crop', value)} />
      <Slider label={copy.positionX} min={-512} max={512} value={visual.x} numeric onChange={value => update('x', value)} />
      <Slider label={copy.positionY} min={-512} max={512} value={visual.y} numeric onChange={value => update('y', value)} />
      <Slider label={copy.rotate} min={-180} max={180} value={visual.rotation} units="°" numeric onChange={value => update('rotation', value)} />
      <Slider label={copy.opacity} value={Math.round(visual.opacity * 100)} units="%" onChange={value => update('opacity', value / 100)} />
      <div className="flip-controls">
        <button className="icon-button" aria-label={copy.flipH} title={copy.flipH} aria-pressed={visual.horizontal} onClick={() => update('horizontal', !visual.horizontal)}><FlipHorizontal2 size={20} /></button>
        <button className="icon-button" aria-label={copy.flipV} title={copy.flipV} aria-pressed={visual.vertical} onClick={() => update('vertical', !visual.vertical)}><FlipVertical2 size={20} /></button>
        <button className="icon-button" aria-label={copy.reset} title={copy.reset} onClick={reset}><RotateCcw size={18} /></button>
      </div>
    </Group>
    {!!asset.frames && asset.frames > 1 && <Group title={asset.animated ? copy.frame : copy.page}>
      {asset.animated && <label className="toggle-field"><input type="checkbox" checked={visual.animate} onChange={event => update('animate', event.currentTarget.checked)} />{copy.playAnimation}</label>}
      {(!asset.animated || !visual.animate) && <Slider label={asset.animated ? copy.frame : copy.page} min={1} max={asset.frames} numeric value={visual.frame + 1} onChange={value => update('frame', value - 1)} />}
    </Group>}
    {motion(asset, visual) && <Group title={copy.visualTrack}>
      <TrimControl trim={visual.trim} duration={asset.duration} set={(edge, value) => update('trim', updateTrim(visual.trim, edge, value, asset.duration))} />
    </Group>}
    <TimeField label={copy.offset} value={visual.offset} min={0} max={9900} change={value => update('offset', value)} />
  </>;
}

function TextPanel({ text, update, limited = false }: { text: TextStyle; update: UpdateStyle<TextStyle>; limited?: boolean }) {
  const { copy } = useApp();
  return <>
    <label className="field">{copy.editText}<textarea autoComplete="off" rows={3} maxLength={160} value={text.content} disabled={limited}
      placeholder={limited ? copy.layerLimit : copy.textHint} onChange={event => update('content', event.target.value)} /></label>
    <label className="field">{copy.font}<select value={text.font} onChange={event => update('font', event.target.value as TextStyle['font'])}>
      <option value="sans-serif">{copy.sans}</option><option value="serif">{copy.serif}</option><option value="monospace">{copy.mono}</option>
    </select></label>
    <Slider label={copy.size} min={16} max={96} value={text.size} units="px" onChange={value => update('size', value)} />
    <Slider label={copy.positionY} min={20} max={490} value={text.y} numeric onChange={value => update('y', value)} />
    <label className="color-field">{copy.color}<input type="color" value={text.color} onChange={event => update('color', event.target.value)} /></label>
    <Group title={copy.alignment}><div className="segmented">{(['left', 'center', 'right'] as const).map(side =>
      <button key={side} aria-pressed={text.align === side} onClick={() => update('align', side)}>{copy[side]}</button>)}</div></Group>
    <Slider label={copy.outline} max={12} value={text.stroke} units="px" onChange={value => update('stroke', value)} />
    <label className="color-field">{copy.outlineColor}<input type="color" value={text.strokeColor} onChange={event => update('strokeColor', event.target.value)} /></label>
    <Slider label={copy.shadow} max={18} value={text.shadow} units="px" onChange={value => update('shadow', value)} />
    <label className="color-field">{copy.shadowColor}<input type="color" value={text.shadowColor} onChange={event => update('shadowColor', event.target.value)} /></label>
  </>;
}

function AudioPanel({ asset, style, update }: { asset: StoredAsset; style: SoundStyle; update: UpdateStyle<SoundStyle> }) {
  const { copy } = useApp();
  return <>
    <TrimControl trim={style.trim} duration={asset.duration} set={(edge, value) => update('trim', updateTrim(style.trim, edge, value, asset.duration))} />
    <TimeField label={copy.offset} value={style.offset} min={0} max={9900} change={value => update('offset', value)} />
    <Slider label={copy.gain} max={200} value={Math.round(style.gain * 100)} units="%" onChange={value => update('gain', value / 100)} />
    <Slider label={copy.rate} min={.5} max={2} step={.05} value={style.rate} units="×" onChange={value => update('rate', value)} />
    <p className="inspector-note">{copy.rateHint}</p>
    <div className="trim-fields"><div>
      <TimeField label={copy.fadeIn} value={style.fadeIn} min={0} max={9900} change={value => update('fadeIn', value)} />
      <TimeField label={copy.fadeOut} value={style.fadeOut} min={0} max={9900} change={value => update('fadeOut', value)} />
    </div></div>
    <label className="toggle-field"><input type="checkbox" checked={style.normalize} onChange={event => update('normalize', event.target.checked)} />{copy.normalize}</label>
    <label className="toggle-field"><input type="checkbox" checked={style.muted} onChange={event => update('muted', event.target.checked)} />{copy.mute}</label>
  </>;
}

export function Inspector({ project, assets, tab, media, audio, library, record, extract, recording, canRecord, busy, change,
  select, remove, reset, track, selectTrack, removeTrack, keepTrack }: Props) {
  const { copy } = useApp();
  const [layerId, setLayerId] = useState('');
  const [addAsset, setAddAsset] = useState('');
  const visualAsset = project.media ? assets.get(project.media) : undefined;
  const layers = visualLayers(project);
  const tracks = audioTracks(project);
  const activeTrack = tracks.find(item => item.id === track) ?? tracks[0];
  const activeAudio = activeTrack ? assets.get(activeTrack.asset) : undefined;
  const currentLayer = layers.find(item => item.id === layerId) ?? layers.at(-1);
  const selectedAsset = currentLayer?.kind === 'media' ? assets.get(currentLayer.asset) : undefined;
  const availableAsset = addAsset && project.visualOptions.includes(addAsset) ? addAsset : project.visualOptions[0];
  const atLayerLimit = layers.length >= MAX_LAYERS;
  const atTrackLimit = tracks.length >= 4;
  const visualUpdate: UpdateStyle<VisualStyle> = (key, value) =>
    change(current => ({ ...current, visual: { ...current.visual, [key]: value } }), { group: key });
  const textUpdate: UpdateStyle<TextStyle> = (key, value) =>
    change(current => ({ ...current, text: { ...current.text, [key]: value } }), { group: key });
  const audioUpdate: UpdateStyle<SoundStyle> = (key, value) => {
    if (!activeTrack) return;
    change(current => activeTrack.id === 'primary-audio' ? { ...current, sound: { ...current.sound, [key]: value } } :
      { ...current, tracks: current.tracks.map(item => item.id === activeTrack.id ? { ...item, style: { ...item.style, [key]: value } } : item) },
    { group: activeTrack.id + key });
  };
  function addLayer(kind: Layer['kind']) {
    if (atLayerLimit) return;
    const id = crypto.randomUUID();
    const asset = availableAsset ? assets.get(availableAsset) : undefined;
    if (kind === 'media' && !asset) return;
    const layer: Layer = kind === 'text' ? { id, kind, style: { ...initialText, content: copy.newTextLayer } } :
      { id, kind, asset: asset!.id, style: { ...initialVisual, trim: newTrim(asset!) } };
    change(current => ({ ...current, layers: [...current.layers, layer], order: [...layers.map(item => item.id), id] }));
    setLayerId(id);
  }
  function editLayer(id: string, update: (layer: Layer) => Layer, group?: string) {
    change(current => ({ ...current, layers: current.layers.map(layer => layer.id === id ? update(layer) : layer) }), { group });
  }
  function moveLayer(index: number, direction: number) {
    const order = layers.map(layer => layer.id);
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    change(current => ({ ...current, order }));
  }
  function removeLayer(id: string) {
    change(current => ({ ...current, layers: current.layers.filter(layer => layer.id !== id),
      media: id === 'primary-media' ? null : current.media,
      text: id === 'primary-text' ? { ...current.text, content: '' } : current.text,
      order: current.order.filter(key => key !== id), hidden: current.hidden.filter(key => key !== id) }));
    if (id === layerId) setLayerId('');
  }

  return <aside className="inspector" aria-label={copy.properties}>
    <header><div className="inspector-mark">{tab === 'audio' ? <AudioLines size={17} /> : tab === 'layers' ? <Layers size={17} /> : tab === 'text' ? 'T' : <ImagePlus size={17} />}</div>
      <h2>{tab === 'audio' ? copy.audioSettings : tab === 'text' ? copy.textSettings : tab === 'layers' ? copy.layers : copy.mediaSettings}</h2></header>
    <div className="inspector-content">
      {tab === 'media' && <>
        <button className="button button-outline full" disabled={busy} onClick={media}><Upload size={17} />{copy.replace}</button>
        {project.visualOptions.length > 0 && <div className="asset-list">{project.visualOptions.map(id => {
          const file = assets.get(id);
          return file && <div className={`asset-row ${id === project.media ? 'selected' : ''}`} key={id}>
            <button aria-pressed={id === project.media} disabled={!visualAsset && atLayerLimit} onClick={() => select(file)}>{file.name}</button>
            <button className="icon-button" aria-label={`${copy.remove} ${file.name}`} onClick={() => remove(id)}><Trash2 size={16} /></button></div>;
        })}</div>}
        {visualAsset ? <>
          {visualAsset.mime.startsWith('video/') && <button className="button button-outline full" disabled={busy || atTrackLimit} onClick={extract}><AudioLines size={16} />{copy.extractAudio}</button>}
          <VisualPanel visual={project.visual} asset={visualAsset} update={visualUpdate} reset={reset} />
        </> : <p className="inspector-note">{copy.mediaFormats}</p>}
        {(visualAsset || project.text.content || project.layers.length > 0) && <Group title={copy.stickerShape}>
          <div className="segmented">{stickerShapes.map(shape => <button key={shape} aria-pressed={(project.stickerShape ?? 'square') === shape}
            onClick={() => change(current => ({ ...current, stickerShape: shape }))}>
            {shape === 'square' ? copy.shapeSquare : shape === 'rounded' ? copy.shapeRounded : copy.shapeCircle}
          </button>)}</div>
          <label className="toggle-field"><input type="checkbox" checked={Boolean(project.stickerBorder)}
            onChange={event => change(current => ({ ...current, stickerBorder: event.currentTarget.checked }))} />{copy.stickerBorder}</label>
          <div className="field"><span>{copy.stickerBackground}</span>
            <div className="segmented bg-swatches">
              {([[null, copy.bgTransparent], ['#ffffff', copy.bgWhite], ['#efeae2', copy.bgWhatsapp], ['#171a17', copy.bgDark]] as const).map(([hex, label]) =>
                <button key={label} aria-pressed={(project.background ?? null) === hex}
                  onClick={() => change(current => ({ ...current, background: hex }))}>{label}</button>)}
            </div>
          </div>
        </Group>}
      </>}
      {tab === 'text' && <TextPanel text={project.text} update={textUpdate} limited={!project.text.content && atLayerLimit} />}
      {tab === 'audio' && <>
        <button className="button button-green full" disabled={busy || atTrackLimit} onClick={library}><Headphones size={18} />{copy.catalogOpen}</button>
        <button className="button button-outline full" disabled={busy || atTrackLimit} onClick={audio}><Upload size={17} />{copy.addAudio}</button>
        <button className={`button button-outline full ${recording ? 'danger' : ''}`} disabled={!recording && (busy || !canRecord || atTrackLimit)} onClick={record}>
          {recording ? <Square size={16} fill="currentColor" /> : <Mic size={17} />}{recording ? copy.stopRecord : copy.record}
        </button>
        {recording && <p className="recording-indicator" role="status">{copy.recording}</p>}
        {!canRecord && <p className="inspector-note">{copy.errors['2001']}</p>}
        {atTrackLimit && <p className="inspector-note">{copy.trackLimit}</p>}
        {activeTrack && activeAudio ? <>
          <label className="field">{copy.track}<select value={activeTrack.id} onChange={event => selectTrack(event.currentTarget.value)}>
            {tracks.map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {assets.get(item.asset)?.name}</option>)}
          </select></label>
          <Group title={activeAudio.name}>
            <AudioPanel asset={activeAudio} style={activeTrack.style} update={audioUpdate} />
            {!activeAudio.credit && <button className="button button-outline full" onClick={() => keepTrack(activeAudio)}><Save size={16} />{copy.keepSound}</button>}
            <button className="button button-outline full" onClick={() => removeTrack(activeTrack.id)}><Trash2 size={16} />{copy.remove}</button>
          </Group>
        </> : <><p className="inspector-note">{copy.audioAbout}</p><p className="inspector-note">{copy.audioFormats}</p></>}
      </>}
      {tab === 'layers' && <>
        <div className="layer-list">{layers.map((layer, index) => {
          const title = layer.kind === 'text' ? layer.style.content || copy.layerText : assets.get(layer.asset)?.name || copy.media;
          const hidden = project.hidden.includes(layer.id);
          return <div className="layer-row" data-active={currentLayer?.id === layer.id} key={layer.id}>
            <button type="button" className="layer-select" aria-pressed={currentLayer?.id === layer.id} onClick={() => setLayerId(layer.id)}>{title}</button>
            <div className="layer-actions">
              <button className="icon-button" disabled={index === layers.length - 1} onClick={() => moveLayer(index, 1)} aria-label={`${copy.raiseLayer} ${title}`}><ArrowUp size={16} /></button>
              <button className="icon-button" disabled={index === 0} onClick={() => moveLayer(index, -1)} aria-label={`${copy.lowerLayer} ${title}`}><ArrowDown size={16} /></button>
              <button className="icon-button" aria-label={`${hidden ? copy.showLayer : copy.hideLayer} ${title}`} onClick={() => change(current => ({ ...current,
                hidden: hidden ? current.hidden.filter(id => id !== layer.id) : [...current.hidden, layer.id] }))}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              <button className="icon-button" aria-label={`${copy.removeLayer} ${title}`} onClick={() => removeLayer(layer.id)}><Trash2 size={16} /></button>
            </div>
          </div>;
        })}</div>
        {project.visualOptions.length > 0 && <><label className="field">{copy.selectAsset}<select value={availableAsset} onChange={event => setAddAsset(event.currentTarget.value)}>
          {project.visualOptions.map(id => <option key={id} value={id}>{assets.get(id)?.name}</option>)}</select></label>
          <button className="button button-outline full" disabled={atLayerLimit} onClick={() => addLayer('media')}><ImagePlus size={16} />{copy.addLayer}</button></>}
        <button className="button button-outline full" disabled={atLayerLimit} onClick={() => addLayer('text')}><Type size={16} />{copy.addTextLayer}</button>
        <p className="inspector-note">{copy.layerLimit}</p>
        {currentLayer?.kind === 'text' && <TextPanel text={currentLayer.style} update={(key, value) => {
          if (currentLayer.id === 'primary-text') textUpdate(key, value);
          else editLayer(currentLayer.id, layer => layer.kind === 'text' ? { ...layer, style: { ...layer.style, [key]: value } } : layer, currentLayer.id + key);
        }} />}
        {currentLayer?.kind === 'media' && selectedAsset && <VisualPanel visual={currentLayer.style} asset={selectedAsset} update={(key, value) => {
          if (currentLayer.id === 'primary-media') visualUpdate(key, value);
          else editLayer(currentLayer.id, layer => layer.kind === 'media' ? { ...layer, style: { ...layer.style, [key]: value } } : layer, currentLayer.id + key);
        }} reset={() => currentLayer.id === 'primary-media' ? reset() : editLayer(currentLayer.id, layer => layer.kind === 'media'
          ? { ...layer, style: { ...initialVisual, trim: newTrim(selectedAsset) } } : layer)} />}
      </>}
    </div>
  </aside>;
}
