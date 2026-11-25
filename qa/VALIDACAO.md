# Validação do beta 2.1.0-beta.1

## Verificado nesta entrega

| Área | Resultado | Evidência |
| --- | --- | --- |
| Build e rotas | PASS | TypeScript, Vite, busca, links diretos e cabeçalhos de segurança |
| Mídias P0 | PASS | PNG, orientação JPEG EXIF 1–8, WebP 512 × 512 com alpha, vídeo e áudio |
| Mídias P1 | PASS | GIF, APNG, WebP animado, AVIF, BMP, ICO, TIFF, HEIC, SVG permitido e rejeição de elemento SVG fora da lista |
| Camadas | PASS | Ordem, visibilidade e alteração da composição conferidas pelos pixels do canvas |
| Áudio | PASS | Quatro pistas, recorte, normalização, deslocamento, extração de vídeo, WAV PCM16 48 kHz e Ogg Opus |
| Sincronismo | PASS | Mudança de cor e início de um tom medidos no MP4 exportado, com timestamps preservados. Diferença de 75,8 ms na fixture |
| Exportações | PASS | WebP estático e animado, WAV, Ogg Opus, MP4/WebM, ZIP e cancelamento. FFmpeg, ffprobe e reimportação conferem os resultados |
| Compatibilidade de dados | PASS | Backup real da v2 inicial e backup do beta restaurados sem sobrescrever projetos |
| Biblioteca | PASS | 120 sons com hashes distintos, busca, filtros, créditos, favoritos e biblioteca pessoal |
| Wavi | PASS | Viewer WebGL carrega o GLB local. Modelo principal 337 kB e 11.264 triângulos; modelo leve 121 kB e 3.168 triângulos. Dez clipes e morph targets nos dois modelos |
| PWA | PASS | Manifesto e ícones servidos. Controle do service worker, rotas offline e reprodução de um som previamente carregado |
| Privacidade | PASS | A suíte do Chromium não observou uploads ou requisições para outras origens. Microfone sintético e encerramento de trilhas verificados |
| Interface | PASS | Modo escuro persistente, layout a 390 px e regras automáticas do axe na landing, biblioteca e Studio |
| Dependências | PASS | npm audit sem vulnerabilidades reportadas |

A suíte de navegador foi executada em Chromium 156.0.8078.79 no Linux. As evidências podem ser reproduzidas com os testes do README. Os testes usam origens, projetos e microfone isolados.

## Homologação pendente

- Chrome Android e Safari iPhone em aparelhos físicos, incluindo instalação, compartilhamento nativo, microfone físico, desempenho e variação de codecs.
- Auditoria manual de acessibilidade e medições de Web Vitals. A suíte axe cobre regras automatizáveis em páginas selecionadas.
- Acesso ao site e ao ZIP pela prévia autenticada. O serviço local responde na porta 8765 e a configuração de porta depende do proprietário do ambiente.
- Smoketest em produção no Netlify. O projeto inclui build e configuração estática para uma implantação autorizada.
- Integração nativa de figurinhas sonoras com WhatsApp. Os gates M1 a M5 continuam pendentes. Os formatos exportados neste beta são formatos de mídia e projeto.

## Rastreabilidade

- RF-001–009, RF-011–014, RF-057–059. Studio, composição, camada, importação, quadro/página e os testes de mídia.
- RF-015–022, RF-025–027. Captura, mixer e timeline. RF-020 altera pitch de acordo com a velocidade.
- RF-028–035. Catálogo, busca, filtros, autoria, favoritos, biblioteca pessoal e template de PR com verificações.
- RF-037–043, RF-046. Modal de exportação por capacidade e restauração versionada.
- RF-047–056, RF-060. Autosave, recuperação, idiomas, tema, PWA, exclusão, documentação, Wavi e diagnóstico.
