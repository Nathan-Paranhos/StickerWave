# ADR-019: Gateway Isolado em Node.js/TypeScript para Figurinhas Sonoras no WhatsApp

## Contexto

O frontend do StickerWave foi projetado originalmente para execução local-first no navegador e hospedagem estática no Netlify (`dist/` + Netlify Functions leves para autenticação e metadados). Entretanto, o envio direto de figurinhas sonoras nativas para o WhatsApp requer:
1. Conexão WebSocket multidispositivo persistente (`@whiskeysockets/baileys`) incompatível com funções serverless stateless.
2. Processamento determinístico com FFmpeg/FFprobe (`libwebp`, `libopus`, `loudnorm`) para WebP 512×512 e Ogg/Opus 48 kHz mono sem depender das limitações de codecs/memória do navegador mobile.
3. Adaptação binária do campo Protobuf `26` (`StickerMessage.audioMessage`) no encoder do Baileys.
4. Custódia segura da sessão central do bot WhatsApp, sem expor credenciais aos usuários finais.

## Decisão

1. Criar o serviço isolado `apps/whatsapp-gateway` em **Node.js 24 + TypeScript** com SQLite nativo (`node:sqlite` WAL) e pacote de contratos `@stickerwave/contracts`.
2. Manter `apps/whatsapp-gateway` desacoplado do `npm ci` raiz do Netlify para preservar builds estáticos rápidos e sem dependências nativas no Netlify.
3. Implementar `SoundStickerProtocol` com detecção de suporte nativo vs wrapper runtime idempotente em `proto.Message.StickerMessage.encode` (sem alterar `node_modules/`), protegido pela feature flag `ENABLE_SOUND_STICKERS`.
4. Exigir pareamento exclusivo por administrador na rota `/whatsapp` (autenticada por `GATEWAY_ADMIN_SECRET`) e opt-in explícito por destinatário via mensagem ao bot antes do primeiro envio.

## Consequências

- **Positivas:** o frontend continua funcionando no Netlify caso o gateway esteja offline (fallback para `.wastickers` e MP4 local preservado); concorrência pesada de FFmpeg fica fora da thread principal da UI; envio gera exatamente uma figurinha sonora nativa.
- **Negativas:** o gateway exige infraestrutura de container/VPS persistente (Docker) com volume para sessão e SQLite; uso da biblioteca não oficial Baileys requer testes de regressão a cada atualização.

## Gatilho de revisão

Revisar esta ADR caso a WhatsApp Cloud API / Business Platform oficial passe a suportar `StickerMessage` com áudio embutido documentado, ou caso uma nova versão do Baileys adicione suporte nativo ao campo 26 (`mode === 'native'`).
