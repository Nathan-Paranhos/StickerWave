# StickerWave

Estúdio web local para criar composições de mídia com som. O beta inclui o site de entrada em português e inglês, editor com até oito camadas e quatro faixas, catálogo com 120 efeitos, favoritos, biblioteca pessoal, PWA e Wavi 3D.

## Abrir o pacote

Com Node 22 ou mais recente, copie `.env.example` para `.env`, instale as dependências e sincronize o banco SQLite via Prisma:

```sh
npm ci
npx prisma db push
npm run build
node scripts/serve.mjs
```

Abra o endereço local que aparece no terminal. Crie uma conta grátis para entrar no Studio, salvar seus projetos/favoritos e experimentar **Editar um exemplo** com mídia sintética e prévia estilo WhatsApp.

## Fluxos do beta

- **Mídia** aceita arquivos e colagem. Use o seletor de página ou quadro para documentos e animações. O Studio preserva os originais. SVG é rasterizado a partir de um subconjunto seguro de formas e gradientes.
- **Camadas** permite adicionar mídia e texto, alterar a ordem, ocultar e editar cada item. As faixas de áudio têm recorte, ganho, mute, velocidade, fades, normalização e deslocamento temporal.
- **Biblioteca** lista 120 efeitos licenciados e dá acesso a favoritos e sons pessoais guardados no navegador.
- **Exportar** valida saídas WebP estático e animado, WAV PCM16, Ogg Opus, MP4/WebM e ZIP de projeto. As capacidades de codec variam por navegador.
- **Meus projetos** recupera os rascunhos do navegador e restaura backups v1 e v2 como um novo projeto. Backups conservam mídia original e seus eventuais metadados.
- A PWA permite usar o editor offline após uma visita online. Sons, modelos e conversores ficam disponíveis offline após serem carregados e enquanto estiverem no cache local.
- O editor continua local. A integração nativa de figurinha sonora segue os critérios de validação do SDD. O vídeo exportado é mídia MP4/WebM compartilhável.

## Desenvolvimento e testes

```sh
npm ci
npm run dev
npm test
npm run build
npm run test:dist
npx playwright install chromium
npm run test:browser
```

A suíte de navegador usa FFmpeg, ffprobe e microfone sintético em um perfil isolado. Use `QA_CHROMIUM_PATH` para apontar para um Chromium existente. `QA_OUTPUT_DIR` personaliza o diretório de capturas e exportações de teste.

O `netlify.toml` define o build e a pasta estática. `dist/` inclui `_redirects` e `_headers`. Uma publicação depende de um projeto Netlify autorizado. A prévia privada do Codex usa uma porta autenticada configurada no ambiente.

Para regenerar os 120 sons, execute `python scripts/generate-sounds.py`. A opção `--limit 40` gera o catálogo da primeira homologação. Para regenerar os modelos, use `blender -b --python scripts/build-wavi.py -- public/models`.

Leia o [SDD](docs/SDD.md), a [arquitetura do WhatsApp Gateway](docs/architecture/whatsapp-gateway.md), o [protocolo de figurinhas sonoras](docs/protocol/sound-stickers.md), o [relatório de validação](qa/VALIDACAO.md), o [relatório de compatibilidade WhatsApp](docs/testing/compatibility-report.md) e os [avisos de licença](THIRD_PARTY_NOTICES.md).

## StickerWave WhatsApp Gateway (Figurinhas Sonoras)

O serviço isolado em `apps/whatsapp-gateway` processa mídia via FFmpeg/FFprobe (`libwebp` + `libopus`) e envia figurinhas sonoras nativas (`StickerMessage.audioMessage`, campo Protobuf `26`) por uma conta central de WhatsApp pareada via QR Code em `/whatsapp`.

```sh
# 1) Configurar variáveis do gateway
cp apps/whatsapp-gateway/.env.example apps/whatsapp-gateway/.env

# 2) Executar gateway localmente (porta 3001)
npm --prefix apps/whatsapp-gateway install
npm --prefix apps/whatsapp-gateway run dev

# 3) Testar protocolo, mídia FFmpeg, API, segurança e browser E2E
npm --prefix apps/whatsapp-gateway test
node qa/whatsapp-gateway.browser.mjs
```

Para subir em produção via Docker:

```sh
docker compose up -d --build
```
