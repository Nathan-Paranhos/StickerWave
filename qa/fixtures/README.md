# Mídia sintética para os testes

`transparency.png` contém duas formas sobre fundo transparente. Os oito JPEGs usam quadrantes vermelhos, verdes, azuis e amarelos e um valor distinto na tag EXIF de orientação. Os pixels originais são iguais em cada JPEG.

`video.webm` usa um quadro de cor sólida e o efeito Pop, sintetizado pelo projeto. Para gerar o vídeo a partir da raiz:

```sh
ffmpeg -f lavfi -i color=c=0xc9f45a:s=512x512:r=24 -i public/sounds/pop.wav \
  -shortest -c:v libvpx-vp9 -c:a libopus qa/fixtures/video.webm
```

As imagens de animação contêm duas cores sintéticas com tempos de 120 e 240 ms. HEIC e TIFF têm duas páginas. As variantes de SVG cobrem uma forma permitida e um elemento fora do subconjunto aceito. O vídeo `sync.webm` muda do preto para o branco quando começa um tom de 520 Hz. `v1.stickerwave.zip` veio do editor 2.0 P0 com mídias sintéticas.
