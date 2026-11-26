import {
  STICKER_LIMITS_PROFILE,
  type StickerType,
  type StickerValidationReport,
} from '@stickerwave/contracts';
import { computeSha256Base64, extractWhatsAppExifMeta } from './webp-exif.js';
import { inspectWebpBuffer } from './webp-inspector.js';

export interface ValidateStickerInput {
  webpBuffer: Buffer;
  oggBuffer?: Buffer | null;
  stickerType: StickerType;
  durationMs: number;
  maxWebpStaticBytes?: number;
  maxWebpAnimatedBytes?: number;
  maxAudioBytes?: number;
  maxDurationMs?: number;
}

/**
 * Validates generated WebP/Ogg artifacts against WhatsApp sticker dimensions, size caps,
 * RIFF EXIF `0x5741` tags, and experimental `sound-sha256` binding rules.
 */
export function validateEncodedSticker(input: ValidateStickerInput): StickerValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inspection = inspectWebpBuffer(input.webpBuffer);
  const exifMeta = extractWhatsAppExifMeta(input.webpBuffer);

  const maxStatic = input.maxWebpStaticBytes ?? STICKER_LIMITS_PROFILE.official.staticMaxBytes;
  const maxAnimated = input.maxWebpAnimatedBytes ?? STICKER_LIMITS_PROFILE.official.animatedMaxBytes;
  const maxAudio = input.maxAudioBytes ?? STICKER_LIMITS_PROFILE.experimentalSoundSticker.maxAudioBytes;
  const maxDur = input.maxDurationMs ?? STICKER_LIMITS_PROFILE.official.animatedMaxDurationMs;

  if (!inspection || !inspection.valid) {
    errors.push('WebP inválido ou cabeçalho RIFF corrompido.');
  } else {
    if (inspection.width !== 512 || inspection.height !== 512) {
      errors.push(`Dimensão WebP (${inspection.width}x${inspection.height}) diferente de 512x512.`);
    }
    const maxBytes = inspection.animated || input.stickerType === 'SOUND' ? maxAnimated : maxStatic;
    if (input.webpBuffer.byteLength > maxBytes) {
      errors.push(`WebP excede o limite de ${(maxBytes / 1024).toFixed(0)} KB (${Math.round(input.webpBuffer.byteLength / 1024)} KB).`);
    }
  }

  const hasExif0x5741 = Boolean(exifMeta);
  if (!hasExif0x5741) {
    warnings.push('Metadado EXIF 0x5741 do WhatsApp ausente no WebP.');
  }

  const audioBytes = input.oggBuffer?.byteLength ?? 0;
  let hasSoundSha256 = Boolean(exifMeta?.soundSha256);
  let soundSha256MatchesAudio: boolean | null = null;

  if (input.stickerType === 'SOUND') {
    if (!input.oggBuffer || audioBytes === 0) {
      errors.push('Figurinha sonora requer trilha Ogg/Opus.');
    } else {
      if (input.oggBuffer.subarray(0, 4).toString('ascii') !== 'OggS') {
        errors.push('Trilha de áudio não possui assinatura de contêiner OggS.');
      }
      if (audioBytes > maxAudio) {
        errors.push(`Áudio Ogg/Opus excede limite experimental de ${Math.round(maxAudio / 1024)} KB.`);
      }
      if (exifMeta?.soundSha256) {
        hasSoundSha256 = true;
        const actualSha = computeSha256Base64(input.oggBuffer);
        soundSha256MatchesAudio = exifMeta.soundSha256 === actualSha;
        if (!soundSha256MatchesAudio) {
          errors.push('Tag EXIF sound-sha256 não confere com a trilha Ogg/Opus codificada.');
        }
      } else {
        warnings.push('Tag experimental sound-sha256 ausente no EXIF do WebP.');
      }
    }

    if (inspection && !inspection.animated) {
      warnings.push('Figurinha sonora com WebP estático; clientes móveis esperam flag animated=true.');
    }
    if (input.durationMs > maxDur) {
      warnings.push(`Duração (${(input.durationMs / 1000).toFixed(1)}s) acima dos 10s recomendados.`);
    }
  }

  return {
    valid: errors.length === 0,
    stickerType: input.stickerType,
    hasExif0x5741,
    hasSoundSha256,
    soundSha256MatchesAudio,
    webpAnimated: Boolean(inspection?.animated),
    webpBytes: input.webpBuffer.byteLength,
    audioBytes,
    width: inspection?.width ?? null,
    height: inspection?.height ?? null,
    durationMs: Math.round(input.durationMs),
    warnings,
    errors,
  };
}
