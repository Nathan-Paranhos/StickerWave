import { z } from 'zod';

export const SIZE = 512;
export const MAX_DURATION = 10_000;
export const MAX_SOURCE_DURATION = 60_000;
export const MAX_PIXELS = 4096 ** 2;
export const MAX_LAYERS = 8;
export const MAX_TRACKS = 4;
export const limits = { image: 20 * 1024 ** 2, video: 50 * 1024 ** 2, audio: 20 * 1024 ** 2 };
export const MIME = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/x-icon',
  'image/heic', 'image/tiff', 'image/svg+xml', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav',
  'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac',
] as const;
export const mimeSchema = z.enum(MIME);
export type MediaMime = z.infer<typeof mimeSchema>;
const trimSchema = z.object({
  start: z.number().int().min(0).max(MAX_SOURCE_DURATION - 100),
  end: z.number().int().min(100).max(MAX_SOURCE_DURATION),
}).refine(value => value.end >= value.start + 100 && value.end - value.start <= MAX_DURATION);
const finiteRange = (min: number, max: number) => z.number().finite().min(min).max(max);
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const duration = z.number().int().min(0).max(MAX_DURATION - 100);
const credit = z.object({
  title: z.string().max(100), author: z.string().max(100),
  license: z.enum(['CC0-1.0', 'CC-BY-4.0']), source: z.string().max(300).optional(),
});

export const assetSchema = z.object({
  id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: mimeSchema,
  size: z.number().int().positive().max(limits.video),
  name: z.string().max(200), duration: z.number().int().min(0).max(MAX_SOURCE_DURATION),
  width: z.number().int().min(0).max(4096), height: z.number().int().min(0).max(4096),
  frames: z.number().int().min(1).max(600).optional(),
  animated: z.boolean().optional(),
  frameEnds: z.array(z.number().int().min(20).max(MAX_SOURCE_DURATION)).max(600).optional(),
  credit: credit.optional(),
}).refine(asset => {
  const kind = asset.mime.split('/')[0] as keyof typeof limits;
  return asset.size <= limits[kind] && (kind === 'audio'
    ? asset.width === 0 && asset.height === 0 && asset.duration >= 100
    : asset.width > 0 && asset.height > 0 && asset.width * asset.height <= MAX_PIXELS &&
      (kind === 'image' && !asset.animated ? asset.duration === 0 : asset.duration >= 100));
});
export type Asset = z.infer<typeof assetSchema>;
export type StoredAsset = Asset & { blob: Blob };

const visualSchema = z.object({
  fit: z.enum(['contain', 'cover']), zoom: finiteRange(.25, 4),
  x: finiteRange(-512, 512), y: finiteRange(-512, 512), rotation: finiteRange(-360, 360),
  horizontal: z.boolean(), vertical: z.boolean(), crop: finiteRange(0, 45), trim: trimSchema,
  frame: z.number().int().min(0).max(599).default(0), animate: z.boolean().default(true),
  opacity: finiteRange(0, 1).default(1), offset: duration.default(0),
});
const soundSchema = z.object({
  trim: trimSchema, gain: finiteRange(0, 2), muted: z.boolean(),
  rate: finiteRange(.5, 2).default(1), fadeIn: duration.default(0), fadeOut: duration.default(0),
  normalize: z.boolean().default(false), offset: duration.default(0),
});
const textSchema = z.object({
  content: z.string().max(160), color,
  size: finiteRange(16, 96), align: z.enum(['left', 'center', 'right']),
  font: z.enum(['sans-serif', 'serif', 'monospace']), y: finiteRange(20, 490),
  stroke: finiteRange(0, 12).default(0), strokeColor: color.default('#171a17'),
  shadow: finiteRange(0, 18).default(0), shadowColor: color.default('#171a17'),
});
const layerKey = z.union([z.literal('primary-media'), z.literal('primary-text'), z.uuid()]);
const layerSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.uuid(), kind: z.literal('media'), asset: z.uuid(), style: visualSchema }),
  z.object({ id: z.uuid(), kind: z.literal('text'), style: textSchema }),
]);
const trackSchema = z.object({ id: z.uuid(), asset: z.uuid(), style: soundSchema });
export const stickerShapes = ['square', 'rounded', 'circle'] as const;
export type StickerShape = (typeof stickerShapes)[number];
export const projectSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), id: z.uuid(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  name: z.string().trim().min(1).max(80), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  media: z.uuid().nullable(), audio: z.uuid().nullable(), visualOptions: z.array(z.uuid()).max(8),
  visual: visualSchema, sound: soundSchema, text: textSchema,
  background: color.nullable().default(null),
  stickerShape: z.enum(stickerShapes).default('square'),
  stickerBorder: z.boolean().default(false),
  layers: z.array(layerSchema).max(MAX_LAYERS).default([]),
  tracks: z.array(trackSchema).max(MAX_TRACKS - 1).default([]),
  order: z.array(layerKey).max(MAX_LAYERS + 2).default([]),
  hidden: z.array(layerKey).max(MAX_LAYERS + 2).default([]),
}).refine(value => {
  const layerIds = [...value.layers.map(layer => layer.id), 'primary-media', 'primary-text'];
  const trackIds = value.tracks.map(track => track.id);
  return (value.media === null || value.visualOptions.includes(value.media)) &&
    value.layers.every(layer => layer.kind === 'text' || value.visualOptions.includes(layer.asset)) &&
    value.layers.length + Number(Boolean(value.media)) + Number(Boolean(value.text.content)) <= MAX_LAYERS &&
    new Set(layerIds).size === layerIds.length && new Set(trackIds).size === trackIds.length &&
    new Set(value.order).size === value.order.length &&
    [...value.order, ...value.hidden].every(id => layerIds.includes(id));
}).transform(value => ({ ...value, schemaVersion: 2 as const }));
export type Project = z.infer<typeof projectSchema>;
export type Trim = Project['sound']['trim'];
export type VisualStyle = Project['visual'];
export type TextStyle = Project['text'];
export type SoundStyle = Project['sound'];
export type Layer = Project['layers'][number];
export type Track = Project['tracks'][number];
export const initialVisual: VisualStyle = {
  fit: 'contain', zoom: 1, x: 0, y: 0, rotation: 0, horizontal: false, vertical: false, crop: 0,
  trim: { start: 0, end: 5000 }, frame: 0, animate: true, opacity: 1, offset: 0,
};
export const initialSound: SoundStyle = {
  trim: { start: 0, end: 5000 }, gain: 1, muted: false, rate: 1, fadeIn: 0, fadeOut: 0, normalize: false, offset: 0,
};
export const initialText: TextStyle = {
  content: '', color: '#171a17', size: 48, align: 'center', font: 'sans-serif', y: 435,
  stroke: 0, strokeColor: '#171a17', shadow: 0, shadowColor: '#171a17',
};

export function createProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), schemaVersion: 2, revision: 0, name, createdAt: now, updatedAt: now,
    media: null, audio: null, visualOptions: [], visual: structuredClone(initialVisual),
    sound: structuredClone(initialSound), text: { ...initialText },
    background: null, stickerShape: 'square', stickerBorder: false,
    layers: [], tracks: [], order: [], hidden: [],
  };
}

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function updateTrim(trim: Trim, edge: keyof Trim, ms: number, duration: number): Trim {
  const value = Math.round(ms);
  if (edge === 'start') return { ...trim, start: clamp(value, Math.max(0, trim.end - MAX_DURATION), trim.end - 100) };
  return { ...trim, end: clamp(value, trim.start + 100, Math.min(duration, trim.start + MAX_DURATION)) };
}
export const newTrim = (asset: Asset): Trim => ({ start: 0, end: Math.min(asset.duration || 5000, 5000) });

export function visualLayers(project: Project): Layer[] {
  const layers: Layer[] = [...project.layers];
  if (project.media) layers.unshift({ id: 'primary-media', kind: 'media', asset: project.media, style: project.visual });
  if (project.text.content) layers.push({ id: 'primary-text', kind: 'text', style: project.text });
  const ranks = new Map(project.order.map((id, index) => [id, index]));
  return layers.sort((a, b) => (ranks.get(a.id) ?? MAX_LAYERS + 2) - (ranks.get(b.id) ?? MAX_LAYERS + 2));
}
export function audioTracks(project: Project): Track[] {
  return project.audio ? [{ id: 'primary-audio', asset: project.audio, style: project.sound }, ...project.tracks] : project.tracks;
}
export function projectRefs(project: Project): string[] {
  // Store-wide garbage collection can encounter records written by older builds.
  return [...new Set([...project.visualOptions, project.audio, ...(project.tracks ?? []).map(track => track.asset)]
    .filter((id): id is string => id !== null))];
}
export const trackDuration = ({ trim, rate, offset }: SoundStyle) => Math.min(MAX_DURATION, offset + Math.round((trim.end - trim.start) / rate));
export const motion = (asset: Asset, style: VisualStyle) => asset.mime.startsWith('video/') || Boolean(asset.animated && style.animate);
export function projectDuration(project: Project, assets: ReadonlyMap<string, Asset>) {
  const visual = visualLayers(project).flatMap(layer => {
    if (layer.kind === 'text' || project.hidden.includes(layer.id)) return [];
    const asset = assets.get(layer.asset);
    return asset && motion(asset, layer.style) ? [layer.style.offset + layer.style.trim.end - layer.style.trim.start] : [];
  });
  const sound = audioTracks(project).map(track => trackDuration(track.style));
  return Math.min(MAX_DURATION, Math.max(0, ...visual, ...sound) || 5000);
}
export function validateAssets(project: Project, assets: ReadonlyMap<string, Asset>) {
  if (projectRefs(project).some(id => !assets.has(id))) throw new Error('4002');
  if (project.visualOptions.some(id => assets.get(id)?.mime.startsWith('audio/'))) throw new Error('4002');
  for (const layer of visualLayers(project)) {
    if (layer.kind === 'text') continue;
    const asset = assets.get(layer.asset);
    if (!asset || (motion(asset, layer.style) && layer.style.trim.end > asset.duration) ||
      layer.style.frame >= (asset.frames ?? 1)) throw new Error('4002');
  }
  for (const track of audioTracks(project)) {
    const sound = assets.get(track.asset);
    if (!sound?.mime.startsWith('audio/') || track.style.trim.end > sound.duration) throw new Error('4002');
  }
}
