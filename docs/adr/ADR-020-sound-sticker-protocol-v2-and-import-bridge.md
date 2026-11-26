# ADR-020: Protocolo Dual de Figurinhas Sonoras (Envelope 134 / Campo 26), EXIF 0x5741 e Bridge de Importação

- **Status:** Aceito (implementado em código e verificado em testes automatizados; validação em aparelho físico WhatsApp bloqueada por ausência de pareamento QR humano).
- **Data:** 2026-11-26
- **Autor:** Nathan Paranhos (`https://nathan-paranhos.com.br/`)

## Contexto

Na evolução do StickerWave para motor completo de figurinhas estáticas, animadas e sonoras (e complementando a ADR-019):
1. A biblioteca instalada `@whiskeysockets/baileys@7.0.0-rc14` omite tanto `Message.audioStickerMessage` (`134`) quanto `StickerMessage.{premium=24, emojis=25, audioMessage=26}`.
2. A análise comparativa de `alkhrzmy/wa-sound-sticker` (MIT), `DavidRamirez206/whatsapp-sound-sticker-bot` (MIT) e `7ucg/whatsapp-docs/WA_STICKERS.md` (`v2.26.41.6`) demonstrou que:
   - Clientes modernos aceitam o wrapper externo `Message(#134 audioStickerMessage) -> FutureProofMessage(#1) -> StickerMessage(#24/#25/#26)` com `ptt: false`, EXIF `0x5741` incluindo `sound-sha256` e encapsulamento de imagens estáticas em WebP animado de 1 quadro (`VP8X`/`ANIM`/`ANMF`, `isAnimated: true`).
   - APIs oficiais de pacote (`ENABLE_STICKER_PACK` no Android e `UIPasteboard` no iOS) continuam limitadas a packs de 3–30 figurinhas sem áudio, e navegadores Web/PWA não acessam diretamente `ContentProvider` ou Pasteboard binário proprietário sem wrapper nativo.

## Decisão

1. Adotar arquitetura **dual-strategy** configurável (`SOUND_STICKER_PROTOCOL=envelope-134` por padrão, mantendo `sticker-26` como alternativa) em `sound-sticker-protocol.ts`, instalando hooks idempotentes de `create`/`encode`/`decode` em memória sem tocar em `node_modules`.
2. Extrair motor dedicado de metadados EXIF `0x5741` (`webp-exif.ts`) e validador formal (`sticker-validator.ts`), promovendo imagens estáticas pareadas com áudio para 1-frame animado WebP quando dentro do orçamento de 500 KB.
3. Introduzir endpoints canônicos (`/api/stickers/process`, `/api/stickers/add-to-whatsapp`, aliases `/api/whatsapp/*` e `/api/stickers/*`) servidos junto com `/api/v1/*`.
4. Implementar `StickerImportBridge` reportando honestamente limitações de navegador/Android/iOS, fornecendo manifestos `WhatsApp/stickers` válidos para estáticas/animadas e roteando figurinhas sonoras para entrega direta via gateway quando conectado (`ENABLE_WA_BOT=true`).

## Consequências

- Positivas: geração, metadados EXIF, validação SHA-256 e serialização de envelope 134 funcionam de ponta a ponta sem apps terceiros (Sticker Maker / Sticker.ly) e com total cobertura de testes automatizados.
- Riscos/Mitigações: envio real ao WhatsApp depende de conta dedicada em servidor onde `ENABLE_WA_BOT=true`; em produção pública (`stickerwave.onrender.com`), mantém-se `ENABLE_WA_BOT=false` para não transformar nenhuma conta pessoal em bot público.
