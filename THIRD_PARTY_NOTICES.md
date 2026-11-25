# Créditos e dependências

Os 120 WAV de `public/sounds` são sínteses geradas por `scripts/generate-sounds.py` sem material de terceiros. O catálogo declara CC0 1.0. A ilustração do Wavi foi gerada para o projeto. Os modelos GLB e o arquivo Blender são produzidos por `scripts/build-wavi.py`.

| Componente | Licença | Código-fonte correspondente |
| --- | --- | --- |
| Manrope | SIL OFL 1.1 | <https://github.com/googlefonts/Manrope> |
| React e ReactDOM | MIT | <https://github.com/facebook/react> |
| Lucide | ISC e MIT | <https://github.com/lucide-icons/lucide> |
| fflate | MIT | <https://github.com/101arrowz/fflate> |
| Zod | MIT | <https://github.com/colinhacks/zod> |
| Three.js | MIT | <https://github.com/mrdoob/three.js> |
| UTIF | MIT | <https://github.com/photopea/UTIF.js> |
| libheif-js 1.23.5 | LGPL-3.0 | <https://github.com/catdad-experiments/libheif-js/tree/v1.23.5> |
| FFmpeg.wasm wrapper 0.12.15 | MIT | <https://github.com/ffmpegwasm/ffmpeg.wasm> |
| FFmpeg.wasm single-thread core 0.12.10 | GPL-2.0-or-later | <https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10> |

O core FFmpeg.wasm e a distribuição libheif.js rodam em workers independentes, carregados sob demanda, com as licenças de suas respectivas distribuições. O lockfile fixa as versões utilizadas. Os avisos distribuídos com o site estão em `public/licenses`.
