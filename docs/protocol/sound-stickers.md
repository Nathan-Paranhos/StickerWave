# Protocolo de Figurinhas Sonoras — StickerWave Core & Gateway (v2)

## 1. Descoberta técnica: por que WebP puro não transporta áudio

O formato RIFF/WebP padrão suporta quadros estáticos (`VP8 `/`VP8L`), canal alfa (`ALPH`), animações (`VP8X`/`ANIM`/`ANMF`) e metadados `EXIF`/`XMP`. Ele **não possui stream de áudio decodificável nativamente pelo WhatsApp dentro do arquivo `.webp`**. Da mesma forma, envio sequencial (`StickerMessage` seguido de `AudioMessage`) não vincula o toque na figurinha à reprodução sonora.

## 2. Comparação técnica entre Estratégia A e Estratégia B

A engenharia reversa comparou quatro fontes abertas: `7ucg/whatsapp-docs` (`WA_STICKERS.md`, WhatsApp Android `2.26.41.6`), `DavidRamirez206/whatsapp-sound-sticker-bot` (`src/sticker-audio-patch.js`, MIT), `alkhrzmy/wa-sound-sticker` (`src/wire.js` / `src/webp.js` / `src/sender.js`, MIT) e `@whiskeysockets/baileys@7.0.0-rc14`.

| Aspecto | Estratégia A (`sticker-26`) | Estratégia B (`envelope-134`, padrão v2) |
| --- | --- | --- |
| Campo externo `Message` | `Message.stickerMessage` (campo `26`) | `Message.audioStickerMessage` (campo `134`, `FutureProofMessage`) |
| Wrapper interno | Direto em `StickerMessage` | `FutureProofMessage.message (#1)` -> `Message.stickerMessage (#26)` |
| Campos adicionais em `StickerMessage` | `#26 audioMessage` (`AudioMessage`) | `#24 premium` (`bool = false`), `#25 emojis` (`repeated string`), `#26 audioMessage` |
| Metadado EXIF WebP `0x5741` | Opcional em bots simples | Recomendado com `"sound-sha256": base64(sha256(ogg))`, packId, publisher |
| WebP de imagem estática + som | `isAnimated = false` (ou `true`) | Convertido para WebP animado de 1 quadro (`VP8X` + `ANIM` + `ANMF`) com `isAnimated = true` |
| Flag `AudioMessage.ptt` | `true` em bots legados | `false` no envelope `#134` |
| Evidência nas referências | Confirmada em `C30611DTf` (`WA_STICKERS.md`) | Documentada em `WA_STICKERS.md` (`2.26.41.6`) + validada em produção por `alkhrzmy/wa-sound-sticker` |

### Auditoria na versão instalada do Baileys (`@whiskeysockets/baileys@7.0.0-rc14`)

Inspeção direta em `apps/whatsapp-gateway/node_modules/@whiskeysockets/baileys/WAProto/index.d.ts`:
- `proto.Message` não declara `audioStickerMessage` (`134`).
- `proto.Message.StickerMessage` declara campos até `mediaKeyDomain`, omitindo `premium` (`24`), `emojis` (`25`) e `audioMessage` (`26`).
- Sem adaptação em memória, `proto.Message.create` e `proto.Message.encode` descartam silenciosamente todos os campos acima.

## 3. Adaptação isolada em `SoundStickerProtocol` (zero edição em `node_modules`)

O módulo [sound-sticker-protocol.ts](../../apps/whatsapp-gateway/src/whatsapp/sound-sticker-protocol.ts):
1. Detecta dinamicamente se `StickerMessage` (`#26`) ou `Message` (`#134`) possuem suporte nativo.
2. Instala hooks idempotentes (`Symbol.for`) de **serialização e desserialização** (`StickerMessage.encode`/`decode` e `Message.create`/`encode`/`decode`) suportando ambas as estratégias (`SOUND_STICKER_PROTOCOL=envelope-134` padrão ou `sticker-26`).
3. Preserva isolamento concorrente via chave composta `${base64(fileSha256)}:${base64(fileEncSha256)}`.
4. Executa round-trip binário via [protobuf-wire.ts](../../apps/whatsapp-gateway/src/whatsapp/protobuf-wire.ts) antes de acionar `relayMessage`, bloqueando o envio se qualquer campo obrigatório estiver ausente.
5. Envia atributo `{ mediatype: 'sticker' }` nas opções de `relayMessage`.

## 4. Metadado EXIF `0x5741` e conversão estática -> 1 quadro animado

Implementado em [webp-exif.ts](../../apps/whatsapp-gateway/src/media/webp-exif.ts):
- Cabeçalho TIFF Big-Endian de 26 bytes com tag `0x5741` (`"WA"`, tipo `UNDEFINED`) e JSON UTF-8 contendo `sticker-pack-id`, `sticker-pack-name`, `sticker-pack-publisher` (`Nathan Paranhos`), `emojis` e `sound-sha256`.
- Quando uma imagem estática é combinada com áudio no fluxo de figurinha sonora, o quadro (`ALPH` + `VP8 ` / `VP8L`) é encapsulado em `VP8X` (`flags` animado + EXIF + alfa) -> `ANIM` -> `ANMF` (duração alvo em ms) + chunk `EXIF`.

## 5. Limites (Oficiais vs Experimentais)

| Parâmetro | Limite oficial documentado (`WhatsApp/stickers`) | Perfil experimental StickerWave (Figurinhas Sonoras) |
| --- | --- | --- |
| Dimensões | 512 × 512 px | 512 × 512 px RGBA |
| WebP estático | ≤ 100 KB (`<= 103.4 KB` no fetcher) | ≤ 100 KB (estático puro); promovido para 1-frame `≤ 500 KB` com som |
| WebP animado | ≤ 500 KB, ≤ 10 s, frame ≥ 8 ms | ≤ 500 KB (`-loop 0`) |
| Áudio Ogg/Opus | Não suportado em packs de terceiros | Ogg/Opus 48 kHz mono (~32 kbps VBR), limite experimental ≤ 512 KB |
| Waveform | N/A | 64 barras normalizadas `0..100` (`Uint8Array`) |

## 6. Riscos e fronteira real de dispositivos

- As APIs oficiais de pacote (`ENABLE_STICKER_PACK` no Android via `ContentProvider` e `UIPasteboard` no iOS) aceitam somente pacotes estáticos/animados (3 a 30 figurinhas WebP) e **não transportam trilha de áudio**.
- Logo, a transmissão de uma figurinha sonora real para dentro do WhatsApp sem apps de terceiros depende do gateway/bot multidispositivo conectado via QR Code (`ENABLE_WA_BOT=true`). Nesta instância pública, `ENABLE_WA_BOT=false` por padrão para preservar os usuários finais.
