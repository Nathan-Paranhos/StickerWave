# Protocolo de Figurinhas Sonoras — StickerWave WhatsApp Gateway

## 1. Descoberta técnica: por que WebP não embute MP3/Opus

O formato RIFF/WebP padrão suporta imagens estáticas (`VP8 `/`VP8L`), canal alfa (`ALPH`) e sequências animadas (`VP8X`/`ANIM`/`ANMF`). Ele **não possui container padronizado nem suporte no WhatsApp para faixas de áudio embutidas dentro do arquivo `.webp`**.

Da mesma forma, pacotes `.wastickers` locais e envios separados (`StickerMessage` seguido de `AudioMessage`) **não produzem uma figurinha sonora nativa** no chat do WhatsApp.

## 2. Estrutura Protobuf validada

Conforme documentação comunitária de engenharia reversa (`7ucg/whatsapp-docs` — `WA_STICKERS.md`, Android 2.26.41.6 `C30611DTf`) e implementação de referência (`DavidRamirez206/whatsapp-sound-sticker-bot`), uma figurinha sonora nativa no WhatsApp utiliza **duas mídias criptografadas e enviadas de forma independente aos servidores MMS do WhatsApp**, combinadas em **uma única mensagem Protobuf**:

```protobuf
message Message {
  optional StickerMessage stickerMessage = 26;
  // future wrapper observado em builds recentes: optional FutureProofMessage audioStickerMessage = 134 (sem uso direto)
}

message StickerMessage {
  optional string url = 1;
  optional bytes fileSha256 = 2;
  optional bytes fileEncSha256 = 3;
  optional bytes mediaKey = 4;
  optional string mimetype = 5;         // "image/webp"
  optional uint32 height = 6;           // 512
  optional uint32 width = 7;            // 512
  optional string directPath = 8;
  optional uint64 fileLength = 9;
  optional int64 mediaKeyTimestamp = 10;
  optional uint32 firstFrameLength = 11;
  optional bytes firstFrameSidecar = 12;
  optional bool isAnimated = 13;
  // ...
  optional string accessibilityLabel = 22;
  oneof audio {
    Message.AudioMessage audioMessage = 26; // wire tag = (26 << 3) | 2 = 210
  }
}
```

### Auditoria na versão instalada do Baileys (`@whiskeysockets/baileys@7.0.0-rc14`)

Inspeção direta em `node_modules/@whiskeysockets/baileys/WAProto/index.js` e `WAProto/index.d.ts`:
- `IStickerMessage` e `StickerMessage.encode` na versão `7.0.0-rc14` definem campos até `mediaKeyDomain` (`tag 184`).
- O campo `26` (`audioMessage`, tag `210`) **não existe no código gerado padrão do `WAProto` dessa versão**.
- Sem adaptação, `proto.Message.StickerMessage.encode` descarta silenciosamente qualquer propriedade `audioMessage`, fazendo a figurinha chegar muda no cliente WhatsApp.

## 3. Adaptação isolada em `SoundStickerProtocol`

O módulo `apps/whatsapp-gateway/src/whatsapp/sound-sticker-protocol.ts`:
1. Nunca modifica arquivos dentro de `node_modules/`.
2. Detecta dinamicamente se a versão instalada do Baileys já serializa o campo `26` nativamente (`detectNativeStickerAudioSupport`).
3. Caso ausente, aplica um wrapper idempotente (`Symbol.for(...)`) em `proto.Message.StickerMessage.encode`.
4. Associa o payload binário de `AudioMessage` usando chave composta `${base64(fileSha256)}:${base64(fileEncSha256)}` — garantindo **zero colisão em envios simultâneos**, mesmo quando dois usuários enviam o mesmo visual com áudios diferentes, porque `fileEncSha256` deriva de `mediaKey` aleatória gerada a cada upload.
5. Serializa a mensagem completa (`proto.Message.encode`) e audita os bytes brutos **antes do `relayMessage`**, falhando caso o campo `26` esteja ausente.

## 4. Pipeline multimídia e limites (Oficial vs Experimental)

| Parâmetro | Limite oficial documentado (`WhatsApp/stickers`) | Perfil experimental StickerWave (Figurinhas Sonoras) |
| --- | --- | --- |
| Dimensões | 512 × 512 px exatos | 512 × 512 px RGBA |
| Visual estático | WebP estático ≤ 100 KB (`<= 103.4 KB` no fetcher) | WebP estático alvo ≤ 100 KB (fallback ≤ 500 KB) |
| Visual animado | WebP animado ≤ 500 KB, ≤ 10 s, frame ≥ 8 ms | WebP keyframes (`libwebp`, `-loop 0`) ≤ 500 KB |
| Áudio | N/A em sticker packs de terceiros | Ogg/Opus 48 kHz mono, VBR (~32 kbps), ≤ 512 KB |
| Waveform | N/A | 64 barras normalizadas `0..100` (`Uint8Array`) |
| `AudioMessage` flags | Voice/audio pipeline (`WhatsApp Audio Keys`) | `mimetype="audio/ogg; codecs=opus"`, `ptt=true`, `seconds` inteiro ≥ 1 |

## 5. Limitações conhecidas e riscos

- Mudanças futuras no protocolo privado do WhatsApp ou na biblioteca Baileys podem alterar o campo `26` ou exigir migração para `audioStickerMessage` (`134`) caso seja padronizado e decodificado pela comunidade.
- Clientes WhatsApp antigos (Android/iOS desatualizados ou versões antigas do WhatsApp Web/Desktop) podem exibir apenas a figurinha sem botão de som se não suportarem `StickerMessage.audioMessage`.
- A conexão usa protocolo multidispositivo não oficial via WebSocket; políticas antispam e limites de envio do WhatsApp permanecem aplicáveis à conta conectada pelo administrador.
