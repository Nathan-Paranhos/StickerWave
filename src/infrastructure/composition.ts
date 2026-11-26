import { motion, SIZE, visualLayers, type Project, type StoredAsset, type VisualStyle } from '../core/project';
import { openDecoder, pagedMime } from './frames';
import { logError } from './logger';
import { closeVisual, drawMedia, drawText, openVisual, seek, type Drawable } from './media';

type Slot = {
  asset: StoredAsset;
  drawable: Drawable | null;
  image?: Awaited<ReturnType<typeof openDecoder>>;
  index: number;
};

export class Composition {
  private readonly slots = new Map<string, Slot>();
  constructor(private readonly signal: AbortSignal) {}

  async open(project: Project, assets: ReadonlyMap<string, StoredAsset>) {
    try {
      for (const layer of visualLayers(project)) {
        if (layer.kind === 'text') continue;
        this.signal.throwIfAborted();
        const asset = assets.get(layer.asset);
        if (!asset) {
          logError('composition', 'missing_visual_asset', { code: '4002', meta: { layerId: layer.id.slice(0, 8), assetId: layer.asset.slice(0, 8) } });
          throw new Error('4002');
        }
        const slot: Slot = { asset, drawable: null, index: -1 };
        this.slots.set(layer.id, slot);
        if (asset.animated) slot.image = await openDecoder(asset.blob, asset.mime, this.signal);
        else if (!pagedMime(asset.mime)) slot.drawable = await openVisual(asset.blob, asset.mime, this.signal);
        this.signal.throwIfAborted();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async update(slot: Slot, style: VisualStyle, at: number, playing: boolean) {
    this.signal.throwIfAborted();
    const elapsed = at - style.offset;
    if (slot.drawable instanceof HTMLVideoElement) {
      const video = slot.drawable;
      const duration = style.trim.end - style.trim.start;
      const valid = elapsed >= 0 && elapsed < duration;
      const target = (style.trim.start + Math.max(0, Math.min(elapsed, duration - 30))) / 1000;
      if (playing && valid) {
        if (video.paused) {
          if (Math.abs(video.currentTime - target) > .04) await seek(video, target, this.signal);
          await video.play();
        } else if (Math.abs(video.currentTime - target) > .055 && !video.seeking) {
          video.currentTime = target;
        }
      } else {
        if (!video.paused) video.pause();
        await seek(video, target, this.signal);
      }
      return;
    }
    let index = style.frame;
    if (slot.image && style.animate) {
      const frameEnds = slot.asset.frameEnds;
      const cursor = Math.min(style.trim.end - 1, style.trim.start + Math.max(0, elapsed));
      const match = frameEnds?.findIndex(end => end > cursor) ?? -1;
      index = match < 0 ? (slot.asset.frames ?? 1) - 1 : match;
    }
    if (index === slot.index || !slot.image && !pagedMime(slot.asset.mime)) return;
    const image = slot.image ? (await slot.image.decoder.decode({ frameIndex: index })).image :
      await openVisual(slot.asset.blob, slot.asset.mime, this.signal, index);
    if (this.signal.aborted) { closeVisual(image); this.signal.throwIfAborted(); }
    if (slot.drawable) closeVisual(slot.drawable);
    slot.drawable = image;
    slot.index = index;
  }

  async prepare(project: Project, at: number, playing = false) {
    for (const layer of visualLayers(project)) {
      if (layer.kind !== 'media' || project.hidden.includes(layer.id)) continue;
      const slot = this.slots.get(layer.id);
      if (slot?.asset.id === layer.asset) await this.update(slot, layer.style, at, playing);
    }
  }

  draw(canvas: HTMLCanvasElement, project: Project, at: number, opaque = false) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('3004');
    ctx.clearRect(0, 0, SIZE, SIZE);
    const shape = project.stickerShape ?? 'square';
    const margin = project.stickerBorder ? 10 : 0;
    const radius = shape === 'circle' ? (SIZE - margin * 2) / 2 : shape === 'rounded' ? 88 : 0;
    const traceShape = (inset: number, r: number) => {
      ctx.beginPath();
      if (shape === 'circle') ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - inset, 0, Math.PI * 2);
      else if (shape === 'rounded') ctx.roundRect(inset, inset, SIZE - inset * 2, SIZE - inset * 2, Math.max(0, r));
      else ctx.rect(inset, inset, SIZE - inset * 2, SIZE - inset * 2);
    };
    if (opaque) {
      ctx.fillStyle = shape === 'square' ? (project.background ?? '#171a17') : (project.background === '#171a17' ? '#242b24' : '#171a17');
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
    ctx.save();
    if (shape !== 'square' || margin > 0) {
      traceShape(margin, radius);
      ctx.clip();
    }
    if (project.background || (opaque && shape !== 'square')) {
      ctx.fillStyle = project.background ?? '#171a17';
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
    for (const layer of visualLayers(project)) {
      if (project.hidden.includes(layer.id)) continue;
      if (layer.kind === 'text') drawText(ctx, layer.style);
      else if (at >= layer.style.offset) {
        const slot = this.slots.get(layer.id);
        if (slot?.asset.id === layer.asset) drawMedia(ctx, layer.style, slot.drawable);
      }
    }
    ctx.restore();
    if (project.stickerBorder) {
      ctx.save();
      traceShape(5, radius + 4);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.restore();
    }
  }

  hasMotion(project: Project) {
    return visualLayers(project).some(layer => {
      if (layer.kind === 'text') return false;
      const asset = this.slots.get(layer.id)?.asset;
      return asset && motion(asset, layer.style);
    });
  }

  pause() {
    for (const { drawable } of this.slots.values()) if (drawable instanceof HTMLVideoElement) drawable.pause();
  }

  close() {
    for (const { image, drawable } of this.slots.values()) {
      image?.close();
      if (drawable) closeVisual(drawable);
    }
    this.slots.clear();
  }
}
