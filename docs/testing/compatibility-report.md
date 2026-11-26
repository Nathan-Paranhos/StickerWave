# Relatório de Testes e Compatibilidade — StickerWave WhatsApp Gateway

Este documento registra com exatidão técnica o escopo executado, os resultados observados e o que exige validação manual em dispositivos físicos pareados com contas reais do WhatsApp.

## 1. Testes automatizados executados

Os resultados exatos após a última alteração devem ser conferidos diretamente na saída dos comandos abaixo (executados na etapa final de verificação):
- `@stickerwave/whatsapp-gateway` (`npm run typecheck`, `npm run build`, `npm run poc`, `npm test` cobrindo `tests/protocol/`, `tests/unit/`, `tests/integration/`, `tests/security/`).
- Raiz StickerWave (`npx tsc --noEmit`, `npm run build`, `npm test`, `npm run test:dist`, `qa/whatsapp-gateway.browser.mjs`, `qa/browser.mjs`).

### O que foi comprovado por código e testes automatizados
1. **Protocolo (`SoundStickerProtocol`):**
   - Campo `26` (`wireTag 210`) serializado em `StickerMessage` com `AudioMessage` (`audio/ogg; codecs=opus`, `ptt: true`, `seconds`, `waveform` 64 barras) dentro de `proto.Message.encode`.
   - Round-trip binário via parser Wire Schema-less confirma presença e integridade do áudio embutido antes do envio, isolando envios simultâneos via chave composta `fileSha256:fileEncSha256`.
   - Figurinhas convencionais subsequentes permanecem sem campo `26`.
2. **Motor multimídia FFmpeg/FFprobe (`ImageProcessor`, `AnimationProcessor`, `AudioProcessor`):**
   - PNG com alfa → WebP 512×512 RGBA estático sem EXIF dentro do orçamento de bytes.
   - GIF / WebM animado → WebP 512×512 RGBA em loop contínuo (`-loop 0`) com controle de FPS/qualidade para ≤ 500 KB.
   - Extração de áudio de vídeos + conversão de WAV/áudios para Ogg/Opus 48 kHz mono + validação por decodificação integral + geração da waveform de 64 barras.
   - Rejeição determinística de assinaturas corrompidas e payloads acima dos limites.
3. **Gateway API, Fila, Conexão e Segurança:**
   - Máquina de estados (`DISCONNECTED`, `CONNECTING`, `WAITING_QR`, `CONNECTED`, `RECONNECTING`, `LOGGED_OUT`), single-flight em `/connect`, geração de QR PNG via SSE e persistência criptografada AES-256-GCM em disco.
   - Desafio opt-in via mensagem recebida pelo bot mockado, envio completo com atualização `SENT` → `DELIVERED` via ACK, `Idempotency-Key`, cancelamento pré-envio e recovery pós-queda (`SENDING` → `UNKNOWN`).
   - Bloqueio `401` em rotas admin, `403` CORS, `400` SSRF e `429` rate limit.

## 2. Matriz de Compatibilidade em Clientes Reais WhatsApp

> **Aviso de integridade:** Nenhuma sessão ativa de WhatsApp pessoal/corporativa foi pareada via câmera de telefone neste ambiente automatizado. Todos os cenários ao vivo abaixo permanecem explicitamente marcados como **`não executado`** até que o administrador pareie uma conta de teste em `/whatsapp`.

| Cliente / Cenário | Reproduzir som | Salvar / Favoritar | Encaminhar | Status | Observações |
| --- | --- | --- | --- | --- | --- |
| WhatsApp Android (celular oficial) | A testar | A testar | A testar | **não executado** | Requer pareamento QR ao vivo do bot em `/whatsapp` e envio para número autorizado |
| WhatsApp Business Android | A testar | A testar | A testar | **não executado** | Validar exibição do ícone de áudio e encaminhamento mantendo áudio |
| WhatsApp iOS (iPhone oficial / Business) | A testar | A testar | A testar | **não executado** | Verificar se `isAnimated` + Ogg/Opus 48kHz reproduzem no toque |
| WhatsApp Web / Desktop | A testar | A testar | A testar | **não executado** | Clientes Web/Desktop podem variar suporte conforme versão do cliente |
