import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { assetSchema, normalizeProjectBounds, projectRefs, projectSchema, validateAssets, type Project, type StoredAsset } from '../core/project';
import { hash, importMedia } from './media';
import { imageExport } from './export';

const maxBytes = 100 * 1024 ** 2;
const files = ['manifest.json', 'project.json', 'licenses.json', 'preview.webp'];
const extensions: Record<StoredAsset['mime'], string> = {
  'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico',
  'image/heic': 'heic', 'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
};
const assetPath = (asset: { id: string; mime: StoredAsset['mime'] }) => `assets/${asset.id}.${extensions[asset.mime]}`;
const path = /^assets\/[0-9a-f-]{36}\.(png|jpg|webp|gif|avif|bmp|ico|heic|tiff|svg|mp4|webm|mp3|wav|ogg|m4a|aac)$/;
const manifestSchema = z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), minReaderVersion: z.union([z.literal(1), z.literal(2)]), assets: z.array(assetSchema).max(12) });
const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

export async function makeBackup(project: Project, collection: ReadonlyMap<string, StoredAsset>, signal: AbortSignal) {
  validateAssets(project, collection);
  const assets = projectRefs(project).map(id => collection.get(id)!);
  if (assets.reduce((sum, asset) => sum + asset.size, 0) >= maxBytes - 1024 ** 2) throw new Error('1002');
  const manifest = manifestSchema.parse({ schemaVersion: 2, minReaderVersion: 2, assets });
  const preview = await imageExport(project, collection, signal);
  const contents: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'project.json': strToU8(JSON.stringify(project)),
    'licenses.json': strToU8(JSON.stringify(assets.flatMap(asset => asset.credit ? [{ asset: asset.id, ...asset.credit }] : []))),
    'preview.webp': await bytes(preview),
  };
  for (const asset of assets) {
    signal.throwIfAborted();
    contents[assetPath(asset)] = await bytes(asset.blob);
  }
  signal.throwIfAborted();
  return new Blob([zipSync(contents, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

function validateDirectory(data: Uint8Array<ArrayBuffer>) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== data.length)) end--;
  if (end < minimum || view.getUint32(end + 4, true) !== 0) throw new Error('4002');
  const count = view.getUint16(end + 10, true);
  if (count > 64 || count !== view.getUint16(end + 8, true)) throw new Error('4002');
  let offset = view.getUint32(end + 16, true);
  if (offset + view.getUint32(end + 12, true) !== end) throw new Error('4002');
  const paths = new Map<string, number>();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('4002');
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end || (mode & 0xf000) === 0xa000 || view.getUint16(offset + 8, true) & 1) throw new Error('4002');
    const name = strFromU8(data.subarray(offset + 46, offset + 46 + nameLength));
    if ((!files.includes(name) && !path.test(name)) || paths.has(name)) throw new Error('4002');
    expanded += size;
    if (expanded > maxBytes || (files.includes(name) && size > 1024 ** 2)) throw new Error('1002');
    paths.set(name, size);
    offset = next;
  }
  if (offset !== end || files.some(name => !paths.has(name))) throw new Error('4002');
  return paths;
}

async function unpack(blob: Blob, signal: AbortSignal) {
  if (blob.size < 22 || blob.size > maxBytes + 65536) throw new Error('1002');
  const data = await bytes(blob);
  const directory = validateDirectory(data);
  let expanded = 0;
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const opened = new Set<string>();
  const unzip = new Unzip(file => {
    const size = directory.get(file.name);
    if (size === undefined || opened.has(file.name) || (file.originalSize !== undefined && file.originalSize !== size)) throw new Error('4002');
    opened.add(file.name);
    const output = new Uint8Array(size);
    let offset = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw new Error('4002');
      expanded += chunk.length;
      if (expanded > maxBytes || offset + chunk.length > size) throw new Error('1002');
      output.set(chunk, offset);
      offset += chunk.length;
      if (final) {
        if (offset !== size) throw new Error('4002');
        contents.set(file.name, output);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < data.length; offset += 4096) {
    if (offset % (1024 * 1024) === 0) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    unzip.push(data.subarray(offset, offset + 4096), offset + 4096 >= data.length);
  }
  if (contents.size !== directory.size) throw new Error('4002');
  return contents;
}

export async function readBackup(file: Blob, signal: AbortSignal) {
  const staged = await unpack(file, signal);
  const json = (name: string): unknown => {
    try { return JSON.parse(strFromU8(staged.get(name)!)); }
    catch { throw new Error('4002'); }
  };
  const project = projectSchema.parse(json('project.json'));
  const manifest = manifestSchema.parse(json('manifest.json'));
  if (manifest.assets.length + files.length !== staged.size || manifest.assets.length !== projectRefs(project).length) throw new Error('4002');
  const assets = new Map<string, StoredAsset>();
  for (const asset of manifest.assets) {
    const content = staged.get(assetPath(asset));
    if (!content || assets.has(asset.id) || content.length !== asset.size) throw new Error('4002');
    const blob = new Blob([content], { type: asset.mime });
    if (await hash(blob) !== asset.sha256) throw new Error('4002');
    const verified = await importMedia(blob, asset.name, asset.mime.startsWith('audio/') ? 'audio' : 'visual', signal);
    if (verified.mime !== asset.mime || verified.width !== asset.width || verified.height !== asset.height ||
      Math.abs(verified.duration - asset.duration) > 500 || (asset.frames ?? 1) !== (verified.frames ?? 1)) throw new Error('4002');
    assets.set(asset.id, { ...asset, ...verified, id: asset.id });
  }
  const normalized = normalizeProjectBounds(project, assets);
  validateAssets(normalized, assets);
  return { project: normalized, assets };
}
