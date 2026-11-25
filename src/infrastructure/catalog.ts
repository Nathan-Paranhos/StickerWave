import { z } from 'zod';
import { importMedia } from './media';

export const categories = ['comedy', 'reactions', 'games', 'interface', 'ambient', 'suspense', 'originals', 'animals'] as const;
const soundSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.object({ pt: z.string(), en: z.string() }),
  description: z.object({ pt: z.string(), en: z.string() }).optional(),
  category: z.enum(categories), tags: z.array(z.string()), durationMs: z.number().int().positive(),
  author: z.string(), license: z.enum(['CC0-1.0', 'CC-BY-4.0']), source: z.string(), bars: z.array(z.number().min(0).max(1)).length(32),
  url: z.string().regex(/^\/sounds\/[a-z0-9-]+\.wav$/), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
  provenance: z.string().optional(), createdAt: z.iso.date().optional(),
  sampleRate: z.number().int().positive().optional(), channels: z.union([z.literal(1), z.literal(2)]).optional(),
  variants: z.array(z.object({ url: z.string(), mime: z.literal('audio/wav'), sha256: z.string(), sizeBytes: z.number() })).optional(),
});
export type Sound = z.infer<typeof soundSchema>;
const catalogSchema = z.object({ schemaVersion: z.literal(1), sounds: z.array(soundSchema) });
let cached: Promise<Sound[]> | undefined;
export function catalog() {
  cached ??= fetch('/sounds/catalog.json').then(async response => {
    if (!response.ok) throw new Error('5001');
    return catalogSchema.parse(await response.json()).sounds;
  }).catch(error => { cached = undefined; throw error; });
  return cached;
}
export async function catalogAsset(sound: Sound, locale: 'pt' | 'en', signal: AbortSignal) {
  const response = await fetch(sound.url, { signal });
  if (!response.ok) throw new Error('5001');
  const asset = await importMedia(await response.blob(), sound.name[locale] + '.wav', 'audio', signal);
  if (asset.sha256 !== sound.sha256 || asset.size !== sound.sizeBytes) throw new Error('5001');
  return { ...asset, credit: { title: sound.name[locale], author: sound.author, license: sound.license, source: sound.source } };
}
