# Segurança — StickerWave WhatsApp Gateway

## Controles implementados

1. **Isolamento de credenciais do WhatsApp (`EncryptedSessionStore`)**
   - Chaves e credenciais Noise/Signal do Baileys são serializadas com `BufferJSON` e criptografadas em repouso com **AES-256-GCM** usando chave derivada via HKDF-SHA256 a partir de `GATEWAY_SESSION_SECRET`.
   - Caminhos de sessão são resolvidos por hash SHA-256 dentro de `SESSION_DIR` (eliminando path traversal).
   - Diretórios `apps/*/data/`, `*.db` e `.env` estão bloqueados no `.gitignore`.

2. **Autenticação administrativa (`/api/v1/whatsapp/*`)**
   - Todos os endpoints administrativos (status, QR, connect, reconnect, disconnect, métricas, lista de jobs, SSE de eventos) exigem `GATEWAY_ADMIN_SECRET` via header `Authorization: Bearer` ou `x-admin-secret`, comparado em tempo constante (`crypto.timingSafeEqual`).
   - O painel `/whatsapp` armazena o segredo apenas em `sessionStorage` da aba e envia-o por cabeçalho HTTP (inclusive para SSE via `fetch` stream — nunca na query string).

3. **Autorização explícita (Opt-in) e privacidade de destinatários**
   - Números passam por normalização estrita E.164 (`libphonenumber-js`).
   - Destinatários não autorizados recebem bloqueio `403 GW-4031` até confirmarem o desafio temporário de 6 caracteres enviando mensagem ao número do bot central.
   - Logs estruturados (`logger.ts`), snapshots e respostas da API mascaram automaticamente números (`+5511*****5432`), JIDs, tokens Bearer, data URLs de QR e URLs `mmg.whatsapp.net`.

4. **Proteção de borda HTTP e processamento multimídia**
   - **CORS restrito** (`ALLOWED_ORIGINS`) retornando `403 GW-4030` para origens não autorizadas.
   - **Rate limit** em janela deslizante por IP e limite horário persistente por número em SQLite (`RATE_LIMIT_SEND_PER_PHONE_PER_HOUR`).
   - **Validação binária (Magic Bytes)** via `sniffMediaBytes` em todas as entradas visuais e sonoras, independente da extensão ou `Content-Type` declarado.
   - **Bloqueio de SSRF:** campos como `visualUrl` / `audioUrl` são rejeitados com `400 GW-4002`; o gateway nunca busca URLs fornecidas pelo usuário.
   - **Zero shell injection:** FFmpeg e FFprobe são invocados exclusivamente com `spawn(..., args, { windowsHide: true })` e lista explícita de argumentos.
   - **Limpeza garantida:** diretórios temporários são removidos em blocos `finally` após sucesso, erro ou cancelamento/timeout.
