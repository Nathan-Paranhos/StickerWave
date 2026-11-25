# StickerWave — Software Design Document

**Estúdio open source de figurinhas sonoras | versão 2.0.0 | 24/11/2026**

| Campo | Definição |
|---|---|
| Organização | Aithos Tech |
| Status | Especificação proposta, não certificação de implementação |
| Plataforma | Web responsiva + backend Node leve (Prisma) |
| Hospedagem | Render / Fly / Railway / VPS único ($0–free tier) ou Vercel/Neon Postgres grátis |
| Idiomas | PT-BR e EN-US |
| Licença proposta | MIT (código); CC0 ou CC BY 4.0 (sons) |
| Identidade | StickerWave / Wavi / Seus memes ganharam voz |
| Revisão | 3.0: conta obrigatória, Prisma zero-custo (SQLite / Postgres grátis) e mídia local |

## 1. Visão do produto

Criar um estúdio gratuito com conta obrigatória, onde cada pessoa cria seu usuário em segundos para acessar o editor, guardar rascunhos e favoritos com segurança, importar uma imagem ou vídeo próprio, combinar com som e exportar figurinhas para WhatsApp. O diferencial é unir **backend enxuto de custo zero (Prisma ORM + SQLite local/único ou Neon/Turso grátis apenas para usuários, sessões e JSON de rascunhos)** com **processamento e armazenamento de mídias pesadas no navegador (IndexedDB por usuário)** — evitando custos de nuvem, egress ou upload de vídeos de 50 MB.

### Escopo e evidência (Revisão 3.0)

- **Entrega direta na web (3.0):**
  - Autenticação própria leve sem SaaS pago: cadastro/login com hash `crypto.scrypt` + cookie de sessão `HttpOnly` persistido em tabela `Session` no **Prisma**.
  - Banco relacional minimalista (`prisma/schema.prisma`): `User`, `Session`, `ProjectRecord` (metadados JSON com controle otimista de revisão) e `FavoriteSound`. **Default zero-config:** SQLite (`file:./stickerwave.db`), portátil com 1 ajuste de `provider` para PostgreSQL gratuito (Neon / Supabase Free).
  - Estúdio local-first por conta (`IndexedDB stickerwave:<userId>`), prévia em bolha WhatsApp, formato/borda/fundo configuráveis e exportação MP4/WebP/WAV/Backup ZIP.
- **Evolução para importação 1-toque em pacote:** requer micro-companion nativo (Android/iOS) usando o SDK oficial assim que a Meta documentar o schema de áudio para terceiros.
- **Não escopo inicial:** feed social público, pagamentos, bot WhatsApp, login por QR e armazenamento de vídeos de 50 MB em servidor cloud (mantidos localmente para garantir custo R$ 0).

## 2. Requisitos funcionais

P0 = primeiro incremento utilizável; P1 = beta evolutivo; P2 = somente após evidência de valor; C = condicionado à pesquisa. A matriz `qa/traceability.csv` detalha IDs, fases e testes. O MVP anterior é uma referência, não a comprovação de todos os requisitos.

### 2.1 Importação e edição visual

| ID | Requisito | Fase |
|---|---|---|
| RF-001 | Importar PNG, JPEG/JPG, WebP estático por seletor, mantendo original | P0 |
| RF-002 | Importar vídeo MP4/WebM se o codec for decodificável | P0 |
| RF-003 | GIF, WebP animado e APNG com seleção explícita de quadro ou animação | P1 |
| RF-004 | Drag and drop e seleção múltipla com limites | P0 |
| RF-005 | Colar imagem/arquivo do clipboard por gesto do usuário | P1 |
| RF-006 | Crop, zoom, pan, redimensionamento, fit/cover | P0 |
| RF-007 | Rotação e espelhamento | P0 |
| RF-008 | Texto, alinhamento, cor, fonte local | P0 |
| RF-009 | Contorno e sombra | P1 |
| RF-010 | Remoção local de fundo manual; automática opcional após ADR | P2 |
| RF-011 | Preservar alpha em formatos que suportam transparência | P0 |
| RF-012 | Undo/redo das operações; histórico limitado | P0 |
| RF-013 | Múltiplas camadas, ordenação e visibilidade | P1 |
| RF-014 | Selecionar início/fim de vídeo | P0 |
| RF-057 | Importador extensível: AVIF, BMP, ICO, HEIC/HEIF, TIFF, SVG seguro, formatos futuros | P1 |
| RF-058 | Aplicar orientação EXIF uma única vez; remover metadados da saída | P0 |
| RF-059 | Selecionar página/quadro de mídias multipágina; avisar se recursos serão perdidos | P1 |

### 2.2 Editor de áudio

| ID | Requisito | Fase |
|---|---|---|
| RF-015 | Importar MP3, WAV, OGG/Opus, AAC/M4A quando decodificáveis | P0 |
| RF-016 | Gravar microfone sob ação do usuário, encerrar todas as tracks | P0 |
| RF-017 | Extrair áudio de vídeo por decoder/motor disponível | P1 |
| RF-018 | Recortar áudio por seleção temporal | P0 |
| RF-019 | Ajustar ganho e mute | P0 |
| RF-020 | Ajustar velocidade; informar efeito sobre pitch | P1 |
| RF-021 | Fade in/out | P1 |
| RF-022 | Normalização por pico e prevenção de clipping | P1 |
| RF-023 | Inverter reprodução | P2 |
| RF-024 | Efeitos de voz locais | P2 |
| RF-025 | Mixar até quatro faixas sonoras | P1 |
| RF-026 | Waveform e controles de transporte | P0 |
| RF-027 | Sincronizar áudio e vídeo usando relógio de mídia | P0 |

### 2.3 Biblioteca

| ID | Requisito | Fase |
|---|---|---|
| RF-028 | Catálogo de sons estático, carregado sob demanda | P0 |
| RF-029 | Busca por nome/tags, sem API | P0 |
| RF-030 | Filtros por categoria e licença | P0 |
| RF-031 | Prévia individual; parar a anterior | P0 |
| RF-032 | Favoritos locais | P1 |
| RF-033 | Mostrar duração, origem, autoria e licença | P0 |
| RF-034 | Contribuições auditáveis via PR | P1 |
| RF-035 | Biblioteca pessoal local | P1 |
| RF-036 | Recentes e destaques editoriais, sem popularidade fictícia | P2 |

### 2.4 Exportação

| ID | Requisito | Fase |
|---|---|---|
| RF-037 | WebP estático 512 × 512; validar MIME e bytes | P0 |
| RF-038 | WAV PCM | P0 |
| RF-039 | Vídeo com áudio MP4 ou WebM conforme capacidade | P0 |
| RF-040 | WebP animado | P1 |
| RF-041 | OGG/Opus mediante encoder testado | P1 |
| RF-042 | Backup ZIP versionado com manifesto e ativos | P0 |
| RF-043 | Compartilhamento por Web Share ou download | P0 |
| RF-044 | Figurinha sonora nativa com evidência por ambiente | C |
| RF-045 | Pacotes de figurinhas com SDK oficial quando aplicável | P2 |
| RF-046 | Restaurar backup validado, sem sobrescrever silenciosamente | P0 |

### 2.5 Experiência e armazenamento

| ID | Requisito | Fase |
|---|---|---|
| RF-047 | Autosave transacional no dispositivo | P0 |
| RF-048 | Recuperar rascunho após fechar/reabrir | P0 |
| RF-049 | PT-BR e EN-US; strings fora dos componentes | P0 |
| RF-050 | Tema claro/escuro | P1 |
| RF-051 | PWA instalável se ambiente suportar | P1 |
| RF-052 | Offline para recursos já armazenados | P1 |
| RF-053 | Excluir dados locais após confirmação | P0 |
| RF-054 | Documentação para usuários e devs | P0 |
| RF-055 | Wavi 3D com fallback estático | P1 |
| RF-056 | Reação do Wavi à amplitude/frequência de áudio | P1 |
| RF-060 | Diagnóstico local de compatibilidade e erros | P0 |

## 3. Arquitetura de software

### 3.1 Decisão: modular monolith frontend, local-first

Reduzir de dez pacotes e múltiplos frameworks para **um app Vite/React/TypeScript strict**, com fronteiras claras em pastas. O domínio é puro TS; a camada de aplicação coordena casos de uso; infra implementa ports de codec, storage e export; features/UI dependem da aplicação. Nada de servidor .NET, Node runtime em produção, banco remoto, filas distribuídas ou microserviços. Node é ferramenta de build. Diagrama editável em `referencias/visuais/arquitetura.mmd` e SVG.

```text
UI React -> Application use cases -> Core domain + ports
                               ^            ^
                               |            |
                 adapters browser / storage / worker
```

Composition root injeta adapters; core nunca importa DOM, React, IndexedDB ou workers. A direção das dependências de código é para o domínio. O fluxo de execução pode chamar os adapters via interfaces. O core usa milissegundos inteiros, IDs UUID e versões explícitas.

### 3.2 Stack por maturidade

| Elemento | Primeiro incremento | Somente se necessário |
|---|---|---|
| UI | React, Vite, TS, CSS/tokens, Lucide | Radix em diálogos complexos; Motion se CSS insuficiente |
| Estado | Reducer/context por feature, selectors | Zustand se compartilhamento/medição justificar |
| Visual | Canvas 2D, DOM para controles acessíveis | Fabric.js ou Konva, escolher um via spike de camadas |
| Áudio | Web Audio API, waveform Canvas, MediaRecorder | WaveSurfer se edição avançada demandar |
| Vídeo | HTMLMediaElement, canvas capture, MediaRecorder | WebCodecs + muxer OU FFmpeg WASM single-thread, não ambos por padrão |
| Persistência | IndexedDB com um wrapper (Dexie candidato) | OPFS se benchmark de blobs exigir |
| Validação | Zod nas fronteiras ou schema equivalente único | Nunca duplicar esquemas manualmente |
| Backup | fflate ou equivalente auditado | Streaming para projetos grandes |
| 3D | SVG/WebP estático inicial | Blender GLB + Three.js lazy; R3F só se útil |
| QA | Vitest, Testing Library, Playwright, axe | Dispositivos reais e ffprobe no CI/lab |
| i18n | Dicionários PT/EN | i18next se pluralização e expansão exigirem |
| PWA | Nenhum SW inicialmente | Workbox após estratégia de atualização testada |
| Repositório | npm ou pnpm com lockfile único (pnpm proposto) | Workspaces quando publicar SDK |

Cada nova dependência tem proprietário, justificativa, alternativa nativa, licença, tamanho gzip/WASM e plano de atualização. Não instalar bibliotecas da coluna opcional antecipadamente.

### 3.3 Estrutura física inicial

```text
stickerwave/
  src/
    app/                # composição, router, bootstrap
    core/               # Project, invariantes, operações puras
    application/        # casos de uso e ports
    infrastructure/     # codecs, storage, export, capability registry
    workers/            # processamento pesado
    features/           # editor, sounds, projects, export, mascot
    ui/                 # primitivas acessíveis e tokens
    locales/            # pt-BR, en-US
  public/{sounds,models,icons}/
  tests/{unit,integration,e2e,fixtures}/
  research/sound-sticker-protocol/
  docs/adr/
  scripts/
  netlify.toml
  AGENTS.md
  README.md
```

**Extração do SDK:** após dois consumidores reais ou uma necessidade clara de distribuição e API estável; mover core/media para `packages/`, introduzir pnpm workspaces, preservar contratos e testes. Não reorganizar o projeto apenas para aparentar sofisticação.

## 4. Identidade visual, UI e UX

Direção artística: utilidade de editor criativo com acabamento de macOS, organização de catálogo inspirada no Spotify, timeline inspirada no CapCut e expressividade de LINE Stickers. Não copiar layouts ou marcas. Links e notas em `referencias/visuais/REFERENCIAS.md`; wireframes originais SVG e PNG nesta pasta.

### 4.1 Design system

Lima #C9F45A, Carbon #171A17, Canvas #F7F8F4, Forest #364635, Lavender #DAD4F2, Stone #E5E8E0. Inter/Manrope com fallback de sistema; revisar licença antes de distribuir fontes. Espaçamento 4/8/12/16/24/32/48; raio 8–16; contraste WCAG 2.2 AA verificado, nunca texto branco sobre lima. Componentes: Button, IconButton, Dialog, Tooltip, FileDrop, Waveform, Timeline, LayerRow, SoundRow, Progress, Toast, EmptyState, ErrorState. Sem neon, vidro em excesso, emojis como ícones, gradientes promocionais ou cards em cascata.

### 4.2 Landing page

Header compacto com marca, Biblioteca, GitHub e idioma. Hero: “Seus memes ganharam voz.” / “Crie figurinhas com os sons que você quiser.” CTA único “Criar figurinha”; Wavi à direita; exemplos sonoros com play, sem autoplay. Abaixo, três passos e seção de privacidade/licenças. Rodapé aberto. A abertura do editor não depende de assistir à animação.

### 4.3 Studio

Desktop: header com nome do projeto, status de save, undo/redo e exportar; trilho esquerdo Mídia/Texto/Áudio/Camadas; preview central xadrez; inspector contextual à direita; timeline inferior com faixa visual e sonora, play/stop, playhead, duração, handles, zoom. Abrir seletor de arquivos em área vazia; manter originals; editar sem destruir.

Mobile: preview central, painel inferior com abas; timeline com zoom e handles grandes, botão de exportar fixo sem cobrir conteúdo. Controles com alvo recomendado de 44 px; teclas e campos numéricos equivalentes para operações de arrastar. Sem scroll horizontal global. Respeitar safe-area, teclado e orientação.

Estados obrigatórios: vazio, importando, conversão necessária, formato incompatível, editando, salvando, salvo, erro de quota, preview, exportando, cancelado, concluído, sem codec, offline e erro recuperável. Erros com ação de recuperação e código técnico; sem resetar projeto.

### 4.4 Rotas

`/` landing; `/studio` novo; `/studio/:projectId` projeto local; `/sounds` catálogo; `/projects` rascunhos; `/favorites` P1; `/docs`, `/contribute`, `/about`, `/privacy`, `/licenses`. Um único SPA; links profundos testados. No beta inicial páginas simples podem ser seções em vez de rotas extras.

### 4.5 Fluxo de entrada

CTA → selecionar imagem/vídeo ou arrastar → validar e detectar formato → converter se necessário (feedback/cancelamento) → escolher som, importar ou gravar → ajustar recorte e volume → preview → selecionar formato de saída → validação → baixar/compartilhar. Mostrar capacidade real, sem exigir que o usuário saiba o formato de entrada.

## 5. Mascote 3D — Wavi

Criatura arredondada com corpo lima fosco, fones grafite, olhos expressivos, boca animável, pequenos braços e pés; personalidade curiosa, divertida, sem poluição visual. Preservar silhueta para favicon, stickers e avatar. Referência conceitual original incluída; não é modelo 3D pronto.

Entregáveis de produção: `wavi.blend` (fonte editável), `wavi.glb`, `wavi-low.glb`, `wavi-static.webp`, `wavi.svg`, `wavi-avatar.png`. Rig simples com root, cabeça/corpo, braços, olhos e morph targets para blink e boca. Material fosco, luz ambiente suave, sem bloom. Animações idle, blink, head-bob, talk, listening, dance, thinking, celebrate, confused, sleep. Blender → glTF/GLB → GLTFLoader + AnimationMixer. Compressão opcional somente após benchmark e licença do decoder.

Máquina de estados: IDLE → LISTENING/PLAYING/PROCESSING → SUCCESS/ERROR → IDLE; cancelar retorna IDLE. Precedência processing > recording > playing > idle; não manter múltiplos loops concorrentes. Wavi não é fonte de feedback exclusiva: texto/aria-live também sinalizam resultado.

Audio AnalyserNode, RMS suavizado (EMA), bandas graves para head-bob, boca limitada por amplitude. Não usar reconhecimento de voz nem enviar áudio. Pausar render quando invisível, tab em background ou bateria/performance ruim. `prefers-reduced-motion` implica estático ou animação discreta sem repetição. Carregamento 3D independente do editor.

Metas propostas: GLB principal ≤1,5 MB, low ≤500 KB, ≤15k triângulos, 60 FPS desktop e 30 FPS em referência mobile; fallback automático após degradação sustentada. Detalhes e animações em `design/WAVI.md`.

## 6. Motor de processamento de mídia

### 6.1 Importador extensível (capability registry)

Aceitar seletor `image/*` mais extensões conhecidas; tratar `accept` apenas como dica, nunca segurança. Arquivo com extensão ou MIME vazio pode ser válido. Detectar assinatura/estrutura com leitura limitada do cabeçalho; validar dimensões/duração e estimar custo antes de decodificar; registrar formato real, origem e orientação. Decodificação com APIs do navegador quando possíveis; adaptadores opcionais por formato, import dinâmico e cancelável. Nenhum arquivo é enviado para conversão remota.

| Formato | Política |
|---|---|
| PNG, JPEG, WebP estático | Obrigatórios no P0; testar alpha e EXIF |
| BMP, ICO, AVIF | Usar decoder nativo onde confirmado; oferecer alternativa caso falhe |
| GIF, APNG, WebP animado, AVIF animado | P1: preservar sequência se decoder testado; P0: avisar e permitir quadro estático |
| HEIC/HEIF (iPhone), TIFF | P1: decoder WASM/JS auditado sob demanda; checar licença/patentes, memória e multipágina |
| SVG | P1: parser seguro allowlist/rasterização; proibir script, eventos, foreignObject, links/referências externas e entidades; não inserir DOM bruto; se não puder garantir segurança, rejeitar |
| RAW, PSD, JPEG XL e outros | Plugin futuro; informar não suportado, preservar original; não prometer suporte universal |

Orientação EXIF exatamente uma vez (testes fixtures 1–8); normalizar cores para sRGB quando possível e avisar sobre perda HDR/ICC não suportado. Preservar original e transparência no projeto; reencode de saída sem EXIF/GPS. Selecionar explicitamente quadro/página; jamais descartar animação sem aviso. Dimensão da composição 512² não limita resolução da entrada; resize fit/cover sem distorção.

### 6.2 Image Engine

Modelo de edição não destrutivo. Operações crop, transform affine, text, layers, draw/render. Canvas 2D com OffscreenCanvas quando disponível, fallback cooperativo. Compressão WebP iterativa com verificação real de MIME (canvas pode retornar PNG) e bytes; alpha e dimensão verificadas; alvo 100 KB para perfil **convencional** estático conforme SDK, não limite sonoro. Se não couber, reduzir qualidade dentro do limiar ou oferecer saída não compatível com aviso; nunca mentir extensão. Para WebP animado investigar encoder e limite convencional separadamente.

### 6.3 Audio Engine

DecodeAudioData/decoder opcional, buffer PCM, sample rate de projeto 48 kHz, mono/stereo, render offline com OfflineAudioContext. Trim em ms convertido em amostras; gain linear, fade com rampas, mix com proteção de pico; seleção de trecho mínimo 100 ms. Waveform por min/max de blocos (não todos os samples), play/stop/seek. Relógio mestre AudioContext quando disponível; preview sincroniza vídeo e cursor. Exportar WAV RIFF PCM16 little-endian, validar cabeçalho/duração/peak. Alteração de playbackRate modifica pitch sem algoritmo específico; preservar pitch só em P2. Parar stream em finish, cancel, error, navegação e unmount; não capturar microfone em background.

### 6.4 Video Engine

Primeira estratégia: decodificar vídeo via elemento de mídia e renderizar composição Canvas + áudio via MediaStreamAudioDestinationNode; MediaRecorder gera saída no codec efetivamente aceito. Testar `isTypeSupported`, depois criar e gravar fixture curta; validar resultado. Realtime pode demorar aproximadamente a duração; pausar exportação ou falhar com aviso se tab/background comprometer frames. MP4 H.264/AAC preferido quando disponível e validado; WebM alternativa; WAV + WebP fallback. Nada de renomear WebM para MP4. Extração de áudio de vídeo depende de suporte a decoder/demux; se falhar, aceitar arquivo sonoro separado.

P1: escolher WebCodecs + muxer (timestamp em microssegundos, flush e mux correto) ou FFmpeg WASM single-thread lazy, de acordo com benchmark iOS/Android. FFmpeg não é requisito para página inicial. Multithread exige SharedArrayBuffer/cross-origin isolation, maior custo de memória e ADR específico. Revisar licenças do core/codecs, distribuição de fontes/notices quando exigido e questões de patentes antes de publicar. Nunca carregar binário remoto não versionado.

### 6.5 Limites propostos e adaptativos

| Item | Inicial | Comportamento |
|---|---:|---|
| Imagem comprimida | 20 MB | validar também pixels, não só bytes |
| Dimensão | 4096 × 4096 | até 16,8 MP e 64 MiB RGBA por frame; limite mobile pode ser inferior |
| Vídeo | 50 MB, 60 s | prévia curta; rejeitar codec desconhecido |
| Áudio | 20 MB, 60 s | estimar PCM decodificado antes do render quando possível |
| Projeto | 5 s padrão, 10 s máximo | limites internos, não especificação WhatsApp |
| Layers | 1 visual + texto P0; 8 P1 | degradação progressiva |
| Audio tracks | 1 P0; 4 P1 | controlar memória/picos |
| Output | 512², 24 FPS | 15 FPS fallback explicitado |
| Jobs | 1 pesado simultâneo | fila curta; cancelar e liberar buffers |
| Backup | 100 MB expandidos / 64 entries | limitar durante descompactação, não confiar no header |

Evitar manter original decodificado em múltiplas cópias; descartar frames e revogar object URLs; liberar ImageBitmap/VideoFrame/AudioContext/Worker após uso. Se memória estimada exceder orçamento, oferecer redução e manter original. Não usar performance.memory como garantia universal. Timeout inicial imagem 15 s, vídeo 60 s, com progresso e cancelamento. Medir em dispositivos reais antes de fechar limites.

### 6.6 Perfis de exportação

`static-webp`, `audio-wav`, `video-mp4`, `video-webm`, `stickerwave-project` P0; `animated-webp`, `audio-opus` P1; `whatsapp-sound-sticker` desabilitado até gate. Cada adapter declara suporte, valida composição, MIME, dimensões, duração, bytes e razão da indisponibilidade. Exportação usa snapshot imutável; retorna arquivos com nome e MIME coerentes. Share via canShare e gesto novo; download fallback. Mostrar instruções manuais somente para fluxos validados no cliente real.

## 7. Biblioteca sonora

Começar com os 12 WAV originais sintetizados do MVP, incluídos em `referencias/audio/`; licença CC0 proposta e precisa ser confirmada pelo mantenedor antes de publicação. Sem samples de terceiros. Crescer para 40 após teste de produto; objetivo 120 no beta estável: 20 reações, 20 comédia, 15 suspense, 20 memes originais, 15 games, 10 animais, 10 interface, 10 ambiente. Não usar áudios de filmes, artistas, memes ou vozes identificáveis sem autorização.

Catálogo JSON versionado por schema e hash, IDs/slugs estáveis, variantes leves OGG/MP3 quando licença/codec permitir e WAV original preservado no Git ou release. Carregar catálogo primeiro; baixar som somente ao tocar/usar. Busca local normalizada (acentos/case), tags e filtros. Um player por vez. Sem autoplay. Favoritos IndexedDB, destaques editoriais e recentes locais, sem números de popularidade inventados.

```ts
interface SoundAsset {
  id: string; slug: string;
  name: { ptBR: string; enUS: string };
  category: string; tags: string[];
  durationMs: number; sampleRate: number; channels: 1 | 2;
  variants: { url: string; mimeType: string; sizeBytes: number; sha256: string }[];
  author: string; sourceUrl?: string;
  license: 'CC0-1.0' | 'CC-BY-4.0';
  provenance: string; createdAt: string;
}
```

Contribuições via PR: original, autoria, declaração de autorização, licença, metadados e análise humana. CI verifica assinatura, duração, pico, tamanho, hash, slug único, URL relativa e schema. A licença do código não cobre mídia; preservar atribuição CC BY inclusive em créditos e manifestos de exportação aplicáveis. Processo de denúncia/remoção e revisão de direitos de voz/privacidade. Fontes de inspiração para sons originais e licenciamento em referências, não redistribuir assets externos sem autorização.

## 8. Modelo de domínio e persistência

Entidades Project, VisualLayer, AudioTrack, MediaAsset, SoundAsset, Preferences, Favorite, ExportHistory. Project 1:N layers/tracks; assets por SHA-256 com referência; deletar asset só se não referenciado. IndexedDB transacional para projects/assets/preferences; sem localStorage para blobs. Estado React contém IDs, não cópias de buffers. Autosave debounce 500 ms, flush em alterações críticas e visibilitychange quando possível, sem confiar em beforeunload. Exibir saved apenas após commit. QuotaExceededError → aviso, limpar cache opcional, baixar backup; nunca apagar projetos automaticamente. `navigator.storage.estimate/persist` quando disponíveis, sem garantir persistência. Coordenação de tabs por lock/revision check; avisar conflito, opção duplicar projeto. Migrações versionadas com rollback transacional.

```ts
interface StickerProject {
  id: string; schemaVersion: number; revision: number; name: string;
  canvas: { width: 512; height: 512; background: string | null };
  durationMs: number; visualLayers: VisualLayer[]; audioTracks: AudioTrack[];
  createdAt: string; updatedAt: string;
}
interface VisualLayer {
  id: string; kind: 'image'|'video'|'text'; assetId?: string; text?: string;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotationDeg: number };
  crop?: { x: number; y: number; width: number; height: number };
  sourceStartMs?: number; sourceEndMs?: number; timelineOffsetMs: number;
  opacity: number; visible: boolean;
}
interface AudioTrack {
  id: string; assetId: string; sourceStartMs: number; sourceEndMs: number;
  timelineOffsetMs: number; gain: number; playbackRate: number;
  fadeInMs: number; fadeOutMs: number; muted: boolean;
}
interface MediaAsset {
  id: string; sha256: string; mimeType: string; sizeBytes: number;
  width?: number; height?: number; durationMs?: number; blob: Blob;
}
```

Invariantes: valores finitos, duração positiva dentro do limite, `start < end ≤ sourceDuration`, offset não negativo, alpha 0..1, gain limitado, fades não maiores que trecho renderizado; asset existe; schema conhecido. IDs nunca vindos de paths livres. `blob` é contrato de infra, não requisito do domínio puro: separar metadata e bytes no código.

Backup `nome.stickerwave.zip` inclui manifest.json, project.json, licenses.json, preview.webp, assets/{id}.{ext}. Manifesto contém schemaVersion, minReaderVersion, hashes, MIME, bytes, IDs. Importar em staging, validar caminho sem `..`/absolute/symlink, limites de expansão, hashes, schemas e referências; commit atômico, duplicar ID em conflito. Nunca abrir HTML/SVG bruto do backup. Exportação de backup preserva originais e portanto possíveis metadados privados: aviso explícito. Exportação de mídia limpa metadados.

## 9. Contratos internos e SDK

Sem API HTTP inicial. Contratos TS entre componentes e adaptadores; schemas Zod para fronteiras não confiáveis. Use cases: ImportMedia, CreateProject, ApplyEdit, UndoRedo, Preview, AddSound, SaveProject, RenderExport, RestoreBackup, DeleteProject. Comandos retornam `Result<T, DomainError>` ou falhas discriminadas, não `any`.

```ts
interface MediaImporter {
  readonly id: string;
  probe(header: Uint8Array, declaredMime: string): Promise<ProbeResult>;
  decode(file: Blob, limits: ImportLimits, signal: AbortSignal): Promise<DecodedAsset>;
}
interface ExportAdapter {
  readonly id: string;
  capabilities(): Promise<CapabilityResult>;
  validate(project: ProjectSnapshot): Promise<ValidationResult>;
  export(project: ProjectSnapshot, options: ExportOptions, signal: AbortSignal,
    onProgress: (ratio: number) => void): Promise<ExportResult>;
}
```

Registry escolhe adapter por assinatura real e disponibilidade; não importa pacote pesado antes da escolha. Worker request é união discriminada `{jobId, operation, payload}` validada por operação; response `{jobId,type:progress|completed|failed|cancelled,...}`. Transferable ArrayBuffer e ImageBitmap quando suportado; nunca reutilizar buffer transferido. Job lifecycle queued→running→completed/failed/cancelled. AbortSignal convertido em mensagem de cancel; se motor não coopera, terminate worker, limpar recursos, recriar sob demanda. Ignorar resposta tardia por jobId; timeout e fila de 1. Snapshot inclui revisão do projeto, asset references, perfil e opções. O contrato do SDK só será publicado após compatibilidade semântica, testes cross-runtime e namespace npm verificado. Nomes candidatos `@stickerwave/core`, `/image`, `/audio`, `/export`, `/sounds`.

## 10. Integração WhatsApp — maturity gates

Não utilizar login QR, token, sessão de WhatsApp, scraping de usuários ou bot no Netlify. Pesquisa isolada em `research/`, contas e dispositivos próprios, respeitar termos e permissões. Priorizar cliente oficial, SDK e recursos documentados. Protocolo não oficial não é uma dependência do produto público. Ver R01–R05 e `research/WHATSAPP-POC.md`.

| Nível | Evidência exigida | Status inicial |
|---|---|---|
| M0 – hipótese | Reportagens, SDK convencional, campos de áudio em relatório independente | Evidência documental; não operacional |
| M1 – baseline | Receber e ouvir figurinha real em conta habilitada; registrar versão/plataforma | Pendente |
| M2 – preparação | Vídeo gerado localmente tem vídeo/áudio válidos; fluxo de criação pelo cliente oficial testado; som preservado | Pendente |
| M3 – compatibilidade | Repetir em Android e iOS habilitados, salvar, encaminhar, reabrir; 10/10 por ambiente alvo; documentar Web | Pendente |
| M4 – importação nativa | Mecanismo autorizado/documentado ou integração aprovada, independente de sessão privada; validação ponta a ponta, segurança | Pendente |
| M5 – produção | Regressão por release, matriz publicada, fallback, testes de clientes não habilitados e critérios de rollback | Pendente |

Gates são cumulativos para o perfil alegado, não notas subjetivas. M2/M3 validam **criação guiada pelo WhatsApp**, não export direto. M4 é necessário para botão de figurinha nativa. Se M2 falhar, continuar export genérico de mídia com descrição honesta; priorizar outras melhorias de estúdio ou reavaliar posicionamento. Se acesso ao recurso não estiver liberado, marcar `BLOCKED_FEATURE_ROLLOUT`, nunca falha da aplicação por padrão. Maturidade real atual não aumentou por escrever esta SDD. Testes ainda não executados.

## 11. Segurança e privacidade

Local-first, sem analytics inicial, sem upload de mídia/credenciais. HTTPS, CSP, nosniff, frame-ancestors, referrer policy, microphone=(self), camera/geolocation=(). Servir assets same-origin; sem CDN de scripts de terceiros. CSP precisa permitir recursos mínimos, e WASM eventualmente `wasm-unsafe-eval` após teste, não `unsafe-eval` genérico. COOP/COEP apenas se multithread justificar; testar compartilhamento e embeds. Netlify logs técnicos podem existir, explicar política.

Ameaças e controles: XSS/metadata → textContent/React escaping, SVG seguro, schemas e CSP; arquivos malformados → sniff, limites, worker e timeout; ZIP bomb/path traversal → quotas durante descompressão, sem paths absolutos; DoS de memória → estimativa de pixels/PCM/frames, fila 1, release; supply chain → lockfile, pin actions, SBOM, audit, revisão licenças; captura indevida → gesture e stop tracks; perda de dados → autosave/backup; vazamento → no network upload, teste de interceptação de requisições; catálogo ilícito → revisão de origem, takedown; service worker obsoleto → cache versionado e update controlado. Relatório sanitizado, sem nomes de arquivos pessoais. `config/_headers.example` é ponto de partida, validar em deploy preview.

## 12. Requisitos não funcionais e performance

Metas a medir, não resultados: LCP ≤2,5s, INP ≤200ms, CLS ≤0,1 (p75 quando houver amostras); JS inicial ≤300 KB gzip; GLB lazy; preview ≥30 FPS em celular de referência; WebP 512² ≤3 s em fixture; vídeo 5 s ≤20 s desktop alvo, sem travar UI; meta operacional 99,5% sem SLA próprio; WCAG 2.2 AA; PT/EN; 85% linhas e branches do core; zero vulnerabilidade crítica conhecida sem tratamento; sem upload de mídia. Registrar browser/OS/device/fixture/commit, rede, cold/warm cache e mediana/p95. Benchmark baseline antes de adicionar WASM/3D/PWA. Lighthouse lab não equivale a RUM. Em aparelho lento, reduzir FPS/resolução de preview, pausar mascote, deixar export explícito; saída mantém perfil escolhido ou pede confirmação.

Suporte prioritário Chrome/Edge desktop, Chrome Android real, Safari iPhone real; Firefox e Safari macOS. Playwright WebKit não substitui Safari iOS físico. Navegadores embutidos suporte limitado; exibir abrir no navegador externo. Tabela de capacidades runtime para decoder, encoder, microphone, share, WebGL, storage, worker; não usar UA sniff como fonte principal. Mídia capturada precisa de HTTPS e gesto. Acessibilidade: foco visível, dialog trapping, labels, aria-live, teclado, contraste, sem só-cor, redução de movimento, waveform acompanhada de campos numéricos, descrição textual de sons quando útil.

## 13. Estratégia de qualidade

Testes unitários (invariantes, crop, duration, WAV, export profile, registry), integração (IDB migrations/quota, decode fixtures, worker cancel, sound catalog, backup round-trip), E2E (importar, editar, exportar, recovery, mobile), segurança (SVG/script, MIME spoof, ZIP bomb limitado, no upload), acessibilidade axe + teclado/leitor de tela manual, desempenho e mídia (ffprobe ou parser independente para verificar bytes reais). Testes do protocolo separados dos testes do Studio. Matriz de rastreabilidade e casos em `qa/`. Não confundir teste sintético com teste real de WhatsApp.

Fixtures: PNG alpha, JPEG EXIF 1–8, WebP, GIF animado, AVIF, BMP, SVG benigno e adversarial, HEIC/TIFF licenciados, MP3/WAV/OGG/M4A mono e stereo, silêncio, clipping, vídeo sem áudio, codec não suportado, ZIP com caminho inválido, mídia grande. Gerar localmente sempre que possível; sem dados de clientes. CI mede tipo real, largura/altura, duração, alpha, picos, presença de streams e sincronização (tolerância proposta ≤100 ms em fixture 5 s). Exportação falha se codec/profile obrigatório não cumprir. Evidência: commit, ambiente, requisito, passos numerados, expected/actual, screenshots numerados com dados fictícios, outputs ou hashes, logs sanitizados. `PASS/FAIL/BLOCKED/NOT_RUN` explícitos.

## 14. Infraestrutura e Netlify

GitHub público → CI → preview → aprovação → produção. Branch main protegida, status checks obrigatórios; configurar deploy de produção após validação, não assumir que build preview é QA. Build `pnpm install --frozen-lockfile` + `pnpm build`, `dist` como publish directory. Node LTS e pnpm exatos definidos no bootstrap e versionados. SPA rewrite 200 sem force; assets existentes não devem ser mascarados por fallback. Config em `config/netlify.toml.example`. Não usar functions nem segredos em VITE_. HTTPS e domínio opcional. Smoke pós deploy testa rotas, CSP, mídia local, status e headers; rollback para deploy anterior, migrações IDB backwards-safe ou export/restore.

Cache: HTML/catalog revalidado; assets com hash immutable; áudio/model/WASM sob demanda; service worker P1 precache somente app shell, runtime cache limitado por tamanho/idade; nunca armazenar mídias pessoais em CDN. Atualização PWA não ativa no meio de exportação sem aviso. Netlify free sujeito a limites; calcular tráfego por sessão e builds antes de viralizar, revisar plano/dashboard, alerta 70/90%, reduzir modelo/sons iniciais. Sem custos fixos de servidor previstos, não prometer grátis ilimitado. Política de deploy preview sem credenciais; bloquear publicação de arquivos de pesquisa com sessão/dados pessoais.

## 15. Observabilidade

Local ring buffer com eventos `project.created/saved`, `media.imported/rejected`, `audio.recording.started/stopped`, `export.started/completed/failed/cancelled`, `storage.quota_exceeded`, `worker.timeout`, `codec.unsupported`; duração, versão, ID aleatório e código, sem conteúdo, contatos, arquivos ou IP. Botão copiar diagnóstico sanitizado sob ação do usuário. Sem telemetria remota inicial; se futuro opt-in, ADR e privacidade. Códigos SW-1001 formato, 1002 limite, 1003 corrompido, 1004 decoder ausente, 2001 permissão, 2002 áudio, 3001 encoder, 3002 cancelado, 3003 timeout, 3004 saída inválida, 4001 quota, 4002 schema, 5001 catálogo, 6001 WhatsApp indisponível. Mensagens em PT/EN com ação sugerida; detalhes técnicos não expostos por padrão.

## 16. Governança open source

README, SDD, AGENTS, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, LICENSE, THIRD_PARTY_NOTICES, CHANGELOG, ROADMAP. MIT proposta para código; assets com licença separada; confirmar autoria do modelo/sons e disponibilidade de nome antes de release. Conventional Commits, SemVer, PR pequeno, revisão de código, dependency update, issue templates bug/feature/sound, SBOM e notices. Segurança com canal privado de reporte (GitHub security advisories quando habilitado). Política de não associação à Meta/WhatsApp; não usar logotipo oficial como marca do produto. Contribuições de mídia passam por revisão humana. Releases reproduzíveis com lockfile, hash de artefatos, checklist e matriz de suporte.

## 17. Architecture Decision Records

ADR-001 local-first; 002 React TS; 003 monólito modular e extração tardia; 004 Netlify estático; 005 IndexedDB; 006 workers e fila 1; 007 native-first e conversores lazy; 008 Wavi progressivo; 009 catálogo estático; 010 MIT/CC0/CC BY; 011 registry/adapters; 012 WhatsApp isolado/gates; 013 sem cadastro/backend; 014 sem IA obrigatória; 015 fallback; 016 importadores extensíveis; 017 orçamento de dependências; 018 PWA adiada. Registros em `adr/DECISIONS.md`, todos propostos, revisar após spikes. Cada ADR guarda contexto, alternativas, decisão, consequência e gatilho de revisão.

## 18. Roadmap por entregas, não por quantidade de bibliotecas

| Fase | Incremento | Gate |
|---|---|---|
| 0 | Spike WhatsApp oficial + vídeo de 5 s + matriz de codecs | M1/M2 se disponível; reportar bloqueio |
| 1 | Vertical slice PNG/JPEG + som + preview + WAV/WebP/vídeo | QA E2E em desktop e celular, sem upload |
| 2 | Autosave/backup, biblioteca 12 sons, landing, textos e i18n | P0 aceito, Netlify preview |
| 3 | Importadores adicionais, GIF, HEIC/TIFF/SVG seguro, video engine | Spikes aprovados por formato |
| 4 | Wavi GLB e animações, efeitos, camadas, 40 sons | Performance não regride |
| 5 | PWA, acessibilidade, 120 sons, publicação do SDK se justificada | Beta estável, licenças e testes |
| 6 | Integração sonora nativa, somente M4/M5 | Compatibilidade real publicada |

Não bloquear todo desenvolvimento pela PoC: a fatia vertical pode ocorrer em paralelo ao laboratório. Sem prazo fixo sem capacidade de equipe. Não desenvolver 120 sons, rig completo ou SDK antes da fatia vertical. Release pública pode ser estúdio genérico, mas deve ter rotulagem honesta se M4 ausente.

## 19. Product backlog e critérios de aceite

EP-01 protocolo; EP-02 importação universal progressiva; EP-03 áudio; EP-04 editor; EP-05 export; EP-06 storage; EP-07 library; EP-08 SDK; EP-09 PWA; EP-10 Wavi; EP-11 comunidade; EP-12 native conditional. Backlog em `docs/BACKLOG.md` e rastreabilidade em QA. Scrumban com limite inicial de 2 demandas de desenvolvimento por equipe e 2 em QA (ajustar capacidade); spike timeboxed com hipótese e evidência; revisão semanal; prioridade P0 primeiro.

DoR: problema, requisito, critério de aceite, dependência, design, fixture e teste. DoD: review, lint/typecheck, unit/integration/E2E aplicáveis, evidência de QA, segurança, licença, mobile, docs e deploy preview. Não concluir história só com UI. Exemplos: Given PNG transparente, When exportar WebP, Then saída 512² valida alpha e MIME; Given HEIC sem decoder, When importar, Then oferecer conversor local se disponível ou mensagem clara sem perder original; Given formato de vídeo não suportado, When exportar, Then alternativa real e projeto intacto; Given export em progresso, When cancelar, Then liberar worker/stream/buffers e retornar ao editor.

## 20. Riscos e mitigação

| ID | Risco | Prob. / impacto | Controle / gatilho |
|---|---|---|---|
| RSK-01 | Integração nativa ausente | Alta / crítico | Gates M0–M5, pivot para estúdio de mídia |
| RSK-02 | Protocolo/termos mudam | Alta / alto | Oficial primeiro, laboratório isolado |
| RSK-03 | iOS codecs/memória | Alta / alto | Matriz runtime, fixtures físicas, fallback |
| RSK-04 | Arquivos grandes/malformados | Média / alto | Limites de pixels, duration, worker, cancel |
| RSK-05 | Direitos de áudio/modelo/codecs | Média / alto | Origem, licenças e revisão humana |
| RSK-06 | Tráfego Netlify | Média / alto | Cache, compressão, alerta 70/90% |
| RSK-07 | 3D lento | Média / médio | Lazy, low-poly, fallback, reduced motion |
| RSK-08 | Perda de IDB | Média / alto | backup, quota, transações, aviso |
| RSK-09 | Overengineering | Alta / alto | monólito, ADR e gates de dependências |
| RSK-10 | Concorrentes | Alta / médio | vertical slice, release cedo, comunidade |
| RSK-11 | SVG/ZIP/supply chain | Média / alto | threat model, auditoria e teste adversarial |

Reavaliar em cada release. Responsáveis são papéis propostos (tech lead, QA, mantenedor de mídia e release owner), não pessoas já alocadas. Aceitação de risco documentada, nunca ocultar blocker crítico.

## 21. Métricas de sucesso

Metas aspiracionais: primeira composição simples ≤60 s em testes de usuário; ≥95% exportações em matriz suportada (definir denominador, amostras, erro por perfil); ≥85% cobertura core; zero crítico conhecido não tratado; 120 sons com origem; 100 stars e 5 contribuidores como metas comunitárias, não previsão. Métricas de maturidade: M0–M5 e testes por plataforma; métricas de complexidade: bundle, número de dependências diretas, quantidade de adapters ativos, tempo de build, regressões e esforço de manutenção. Preferir observação controlada e feedback público sem telemetria invasiva.

## 22. Instruções para agentes

Consultar `AGENTS.md` antes de editar. Ler requisitos e ADRs, implementar fatia vertical, preservar core puro, validar formatos reais, manter privacidade, não inventar suporte WhatsApp, não instalar dependências especulativas, respeitar design tokens, não subir assets protegidos, testar mobile real, apresentar evidências e riscos. Nenhum agente autorizado a publicar, enviar mensagens ou usar conta externa sem permissão. Não simular teste E2E aprovado sem execução. O arquivo AGENTS acompanha o pacote.

## 23. Critérios de lançamento

Release P0: formatos obrigatórios importam e exportam conforme matriz; preview e output validados; backups recuperam; sem upload; microfone encerrado; acessibilidade e mobile verificados; catálogo licenciado; CSP em produção; fallback documentado; build/CI/smoke passam. Beta: conversores e Wavi não prejudicam performance, offline declarado só para assets cacheados, matriz atualizada. Release de integração sonora: M4/M5, contas habilitadas, reprodução/salvar/encaminhar, não habilitadas com comportamento documentado; feature flag e rollback. Bloqueios críticos: perda de projeto, arquivo inválido apresentado como válido, segredo/credencial, vulnerabilidade crítica, licença ausente, exportação nativa alegada sem prova.

## 24. Avaliação final e decisões abertas

A proposta reduz a complexidade inicial: um deploy, um app, um core, uma fila local e uma biblioteca de sons estática; sem serviços pagos, orquestração distribuída ou monorepo prematuro. A complexidade intrínseca permanece em codecs, memória mobile, importadores raros, 3D e formato WhatsApp. Não confundir redução arquitetural com resolução desses riscos.

Maturidade atual: especificação e MVP de referência com 12 sons; não há evidência nova de implementação da versão 2.0, 3D real ou integração nativa. Testes de navegador anteriores reportaram bloqueio do Chromium; repetir no ambiente de desenvolvimento. Nomes StickerWave/Wavi, MIT, limites, stack, fontes, prioridades e metas são decisões propostas para revisão do mantenedor. Próxima ação: executar laboratório em aparelho real e construir vertical slice, com QA rastreável. Não assumir que o criador do WhatsApp mantém o áudio de qualquer vídeo; observar o resultado real. Links de referência e assets conceituais em diretórios do pacote. O ZIP não é aplicativo final ou deploy pronto.
