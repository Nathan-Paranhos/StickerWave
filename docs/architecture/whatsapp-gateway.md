# Arquitetura do StickerWave Core & WhatsApp Gateway

## Visão geral

O StickerWave mantém o frontend web React/PWA em `src/` compatível com hospedagem estática no Netlify, enquanto o motor multimídia nativo (FFmpeg/FFprobe), metadados WebP EXIF `0x5741`, validação, ponte de importação e gateway Baileys rodam de forma desacoplada em **`apps/whatsapp-gateway`** (Node.js 24 + TypeScript).

```text
StickerWave Frontend (src/)
   ├── /studio  ──▶ Image/Canvas/Audio Mixer ──▶ POST /api/stickers/process | /api/v1/media/convert
   │                                          └── POST /api/stickers/add-to-whatsapp (Bridge)
   │                                          └── POST /api/stickers/send + SSE (Gateway Bot)
   └── /whatsapp ─▶ Console administrativo protegido (GATEWAY_ADMIN_SECRET + QR SSE)

StickerWave Core & Gateway (apps/whatsapp-gateway)
   ├── CompositionPipeline
   │      ├── ImageProcessor (512x512 WebP RGBA)
   │      ├── AnimationProcessor (GIF/MP4/WebM/WebP -> WebP keyframes ≤ 500 KB)
   │      ├── AudioProcessor (MP3/WAV/OGG/M4A/AAC/Video -> Ogg/Opus 48kHz mono + waveform)
   │      ├── Metadata Engine (webp-exif.ts: EXIF 0x5741, sound-sha256, 1-frame animated promotion)
   │      └── StickerValidator (sticker-validator.ts: 512x512, bytes, EXIF 0x5741, OggS, SHA-256)
   ├── SoundStickerProtocol (Dual Strategy: envelope-134 padrão / sticker-26 fallback + decode hooks)
   ├── StickerImportBridge (Estratégias Web/PWA/Android ContentProvider/iOS UIPasteboard + Bot Relay)
   ├── Security & Auth (Admin Bearer, CORS, Rate Limit IP & E.164, Magic Bytes, SSRF Block)
   └── StickerJobService + GatewayDatabase (SQLite WAL + AES-256-GCM SESSION_DIR)
```

## Contratos compartilhados (`packages/contracts`)

- `StickerWaveProject`, `StickerMetadata`, `StickerType` (`STATIC | ANIMATED | SOUND`), `EncodedSoundSticker`, `StickerValidationReport`.
- `SoundStickerProtocolStrategy` (`envelope-134 | sticker-26`) e `AddToWhatsAppResponse` (`WhatsAppPackManifest` + honestidade por plataforma).
- `WhatsAppConnectionStatus`, `StickerJobStatus`, erros `GW-*` e `STICKER_LIMITS_PROFILE`.

## Recuperação de falhas e idempotência

- Requisições de envio aceitam `Idempotency-Key`, evitando processamento ou entrega duplicada.
- No startup, jobs em estágio anterior à rede (`QUEUED`, `PROCESSING_*`, `ENCODING`) tornam-se `FAILED` recuperáveis; jobs interrompidos em `UPLOADING`/`SENDING` passam para `UNKNOWN` e nunca são reenviados automaticamente.
- `ENABLE_WA_BOT=false` mantém o motor Cloud Media + `/api/stickers/process` + `/api/stickers/add-to-whatsapp` totalmente operacionais sem transformar nenhuma conta pessoal em bot público.
