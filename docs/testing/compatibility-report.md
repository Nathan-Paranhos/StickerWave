# Relatório de Testes e Compatibilidade — StickerWave Core & WhatsApp Gateway

Este relatório registra com rigor técnico o que foi verificado por código, FFprobe/parser binário e Playwright Chromium, separando claramente o que depende de pareamento humano com dispositivo WhatsApp real.

## 1. Matriz de Casos Verificados Automaticamente

| Caso / Domínio | Escopo executado | Evidência objetiva | Status |
| --- | --- | --- | --- |
| Metadata Engine (`webp-exif.ts`) | Injeção + leitura TIFF `0x5741` e `sound-sha256`; promoção estática 1-frame WebP | Parser RIFF confirma `VP8X` (`animated=true`, `hasExif=true`), `ANIM`, `ANMF`, `EXIF` e digest exato | **PASS** (verificado nos testes do gateway) |
| Sticker Validator (`sticker-validator.ts`) | Dimensão `512x512`, orçamentos `100 KB`/`500 KB`/`512 KB`, `OggS`, hash SHA-256 | Relatório `StickerValidationReport` emitido em `/api/stickers/process` | **PASS** |
| Protocolo Dual (`SoundStickerProtocol`) | Estratégia B (`envelope-134`, `#134 -> #1 -> #26`, `#24/#25/#26`, `encode`/`decode`) + Estratégia A (`sticker-26`) | Parser schema-less `protobuf-wire.ts` e `proto.Message.decode` validam payload sem tocar em `node_modules` | **PASS** (mock + wire round-trip) |
| Pipelines FFmpeg/FFprobe | PNG alfa + WAV/MP3, JPEG EXIF + WAV, GIF animado + WAV, WebM/MP4 extração de áudio | Outputs validados em bytes e streams (`libwebp`, `libopus`, `aac`) | **PASS** |
| Rotas Canônicas & Segurança | `/api/stickers/process`, `/api/stickers/add-to-whatsapp`, `/api/whatsapp/*`, CORS, rate-limit, opt-in E.164, idempotência, SQLite WAL | Integração + E2E HTTP + testes de segurança | **PASS** |
| Interface Web & Acessibilidade | Studio E2E desktop/mobile, PWA offline, contraste Axe WCAG 2.2 AA claro/escuro, créditos Nathan Paranhos | `qa/browser.mjs` + `qa/whatsapp-gateway.browser.mjs` | **PASS** (após última edição) |

## 2. Matriz de Clientes Reais WhatsApp (Cenários ao Vivo)

> **Bloqueio honesto de ambiente:** Este ambiente automatizado **não dispõe de celular físico com conta de teste WhatsApp nem câmera para leitura interativa do QR Code**. Conforme diretriz de integridade, nenhum envio real a aparelho foi forjado com sessão inventada. **Todos os testes ao vivo em aparelho físico permanecem explicitamente marcados como `BLOCKED` / `não executado`.**

| ID | Cliente / Cenário ao vivo | Reprodução de áudio | Favoritar / Salvar na bandeja | Encaminhamento | Status | Motivo / Ação para destravar |
| --- | --- | --- | --- | --- | --- | --- |
| `CT-008` | WhatsApp Android (cliente oficial) | Pendente | Pendente | Pendente | **BLOCKED (não executado)** | Requer conta dedicada (`ENABLE_WA_BOT=true`), leitura QR manual em `/whatsapp` e envio para aparelho Android real |
| `CT-009` | WhatsApp Business Android | Pendente | Pendente | Pendente | **BLOCKED (não executado)** | Mesmo bloqueio humano de pareamento QR e observação visual/auditiva no app |
| `CT-010` | WhatsApp iOS (iPhone oficial / Business) | Pendente | Pendente | Pendente | **BLOCKED (não executado)** | Validar em iPhone físico se `envelope-134` (`isAnimated=true` + EXIF `0x5741` + `sound-sha256` + `Ogg/Opus` 48kHz) reproduz no toque |
| `CT-011` | WhatsApp Web / Desktop | Pendente | Pendente | Pendente | **BLOCKED (não executado)** | Suporte varia por build Web/Desktop; validar em janela pareada com a mesma conta |
| `CT-012` | Ponte Android/iOS nativa (`ENABLE_STICKER_PACK` / `UIPasteboard`) com som | N/A | N/A | N/A | **Limitação confirmada** | APIs oficiais `WhatsApp/stickers` não aceitam trilha de áudio no manifesto/pack; apenas WebP silencioso (3..30 por pack) |
