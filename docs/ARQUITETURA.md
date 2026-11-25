# Arquitetura do StickerWave

React e TypeScript organizam a SPA. O núcleo define schemas de entrada, invariantes de edição, referências e limites. Os adaptadores interligam o núcleo com Canvas, Web Audio, IndexedDB e workers. A interface usa as mesmas funções de composição para prévia e exportação.

## Persistência

O schema 2 mantém a mídia, o texto e o áudio primários da versão anterior e adiciona listas de camadas e faixas, ordem e visibilidade. A leitura migra registros v1 por padrão. A gravação usa uma revisão otimista e uma transação de mídia e metadados. Referências de projeto preservam arquivos compartilhados e permitem recuperar backups sem sobrescrever rascunhos.

Favoritos e biblioteca pessoal usam armazenamentos separados no IndexedDB. O backup versionado contém originais, projeto, prévia, licenças e hashes. O leitor valida limites, estrutura ZIP, caminhos, MIME, hashes e referências antes de gravar.

## Reprodução e exportação

A composição renderiza até oito camadas no canvas 512 × 512. Opacidade, enquadramento, recorte, transformações, estilos de texto e a seleção de quadro ou página são operações não destrutivas. A animação do navegador fornece uma tabela de duração por quadro. A decodificação HEIC/TIFF ocorre em um worker cancelável. O SVG usa tags e atributos permitidos e é rasterizado sem acessar recursos externos.

O mixer renderiza até quatro fontes a 48 kHz via OfflineAudioContext. A prévia usa a posição do relógio de mídia, com compensação de velocidade, recorte, fade e deslocamento. WAV é codificado em worker. O contêiner animado WebP é produzido a partir de quadros WebP renderizados pelo canvas. O FFmpeg WebAssembly single-thread converte som de vídeo e produz Opus sob demanda. MediaRecorder gera o vídeo efetivamente anunciado pelo navegador.

## PWA e Wavi

O service worker versiona o cache do editor pelo hash do build e mantém um cache limitado dos recursos carregados. Mídias pessoais permanecem no IndexedDB. O Wavi 3D é carregado sob ação do usuário. A amplitude e a energia nos graves da reprodução controlam boca e movimento. O renderer é pausado fora de vista e usa fallback estático em caso de preferência por movimento reduzido ou falha.

A distribuição usa rotas estáticas com fallback para a SPA. O target Netlify dispensa funções, chaves e banco remoto. O servidor Node do pacote permite executar o build localmente.
