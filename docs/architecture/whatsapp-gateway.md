# Arquitetura do StickerWave WhatsApp Gateway

## Visão geral

O StickerWave mantém o frontend existente (`src/`) compatível com deploy estático no Netlify, enquanto delega todo processamento multimídia em FFmpeg, fila persistente e sessão multidispositivo Baileys para o serviço isolado **`apps/whatsapp-gateway`** (Node.js 24 + TypeScript).

```text
StickerWave Frontend (React / Vite)
   ├── /studio  ──▶ Renderiza composição (PNG estático ou WebP animado + WAV 48kHz)
   │                    └── HTTPS multipart/form-data + SSE ──▶ StickerWave Gateway API (:3001)
   └── /whatsapp ─▶ Console administrativo protegido (GATEWAY_ADMIN_SECRET)
                        └── SSE + REST ──▶ WhatsAppConnectionManager (QR Code central)

StickerWave Gateway (apps/whatsapp-gateway)
   ├── Security Middleware (Admin Bearer, CORS restrito, Rate Limit IP & Telefone, Magic Bytes)
   ├── AuthorizationService (E.164 libphonenumber-js + desafio opt-in + listener do bot)
   ├── StickerJobService + GatewayDatabase (SQLite WAL persistente + recovery startup)
   ├── CompositionPipeline
   │      ├── ImageProcessor (PNG/JPG/WebP -> WebP 512x512 RGBA sem EXIF)
   │      ├── AnimationProcessor (GIF/MP4/WebM/WebP -> WebP animado keyframes ≤ 500 KB)
   │      └── AudioProcessor (MP3/WAV/OGG/M4A/AAC/Video -> Ogg/Opus 48kHz mono + waveform 64b)
   ├── SoundStickerProtocol (Baileys WAProto campo 26 + validação binária pré-envio)
   └── WhatsAppConnectionManager + EncryptedSessionStore (AES-256-GCM em SESSION_DIR)
```

## Contratos compartilhados (`packages/contracts`)

Tipos e constantes partilhadas sem dependências pesadas:
- `WhatsAppConnectionStatus`: `DISCONNECTED | CONNECTING | WAITING_QR | CONNECTED | RECONNECTING | LOGGED_OUT | ERROR`
- `StickerJobStatus`: `QUEUED | PROCESSING_VISUAL | PROCESSING_AUDIO | ENCODING | UPLOADING | SENDING | SENT | DELIVERED | FAILED | CANCELLED | UNKNOWN`
- Códigos de erro estruturados `GW-*` e perfis `STICKER_LIMITS_PROFILE`.

## Recuperação de falhas e idempotência

- Requisições de envio aceitam cabeçalho `Idempotency-Key`, evitando processamento ou envio duplicado ao repetir cliques ou retentativas de rede.
- Em reinício inesperado do processo, jobs interrompidos antes do upload (`QUEUED`, `PROCESSING_*`, `ENCODING`) tornam-se `FAILED` recuperáveis pelo usuário; jobs interrompidos durante `UPLOADING` ou `SENDING` passam para `UNKNOWN` e **nunca são reenviados automaticamente**, prevenindo entregas duplicadas no WhatsApp.
