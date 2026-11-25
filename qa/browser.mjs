import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createDistributionServer } from '../scripts/serve.mjs';

const files = fileURLToPath(new URL('./fixtures/', import.meta.url));
const outputs = process.env.QA_OUTPUT_DIR
  ? resolve(process.env.QA_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), 'stickerwave-qa-'));
await mkdir(outputs, { recursive: true });
const invalidImage = join(outputs, 'not-image.png');
await writeFile(invalidImage, 'invalid test input');
console.log('QA outputs', outputs);
const browserDbDir = await mkdtemp(join(tmpdir(), 'stickerwave-browser-db-'));
const server = createDistributionServer({ databaseUrl: `file:${join(browserDbDir, 'browser.db').replace(/\\/g, '/')}` });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.QA_CHROMIUM_PATH,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'],
  });
  console.log('Chromium', browser.version());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  await context.addInitScript(() => {
    window.qaMicTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      window.qaMicTracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const jsErrors = [];
  const offOrigin = [];
  const writes = [];
  page.on('pageerror', error => jsErrors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http') && !request.url().startsWith(origin)) offOrigin.push(request.url());
    if (!['GET', 'HEAD'].includes(request.method()) && !new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.method());
  });
  async function checkA11y(label) {
    const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    assert.deepEqual(report.violations.map(({ id, nodes }) => ({ id, elements: nodes.map(node => node.target) })), [], label);
  }
  await page.goto(origin);
  await page.getByRole('heading', { level: 1, name: /Seus memes ganharam voz/ }).waitFor();
  await page.getByRole('button', { name: 'Exibir Wavi em 3D' }).click();
  await page.locator('.hero-art .wavi-model canvas').waitFor();
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /\/models\/wavi(?:-low)?\.glb$/.test(entry.name)));
  await page.getByRole('button', { name: 'Exibir imagem do Wavi' }).click();
  console.log('PASS Wavi WebGL viewer loads its local GLB');
  await page.goto(origin);
  await page.getByRole('button', { name: 'Reproduzir Pop!' }).waitFor();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Pular para o conteúdo');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
  await checkA11y('Landing accessibility');
  await page.screenshot({ path: outputs + '/landing.png', fullPage: true });
  await page.getByRole('button', { name: 'Mudar idioma' }).click();
  await page.getByRole('heading', { level: 1, name: /Your memes found their voice/ }).waitFor();
  await page.reload();
  await page.getByRole('heading', { level: 1, name: /Your memes found their voice/ }).waitFor();
  await page.getByRole('button', { name: 'Change language' }).click();
  await page.goto(origin + '/auth');
  await page.getByLabel('Nome').fill('QA Sticker');
  await page.getByLabel('E-mail').fill('qa@example.com');
  await page.getByLabel('Senha').fill('sticker123');
  await page.getByRole('button', { name: 'Criar conta grátis' }).last().click();
  await page.getByRole('button', { name: 'Editar um exemplo' }).waitFor();
  await page.goto(origin);
  await page.getByRole('link', { name: 'Explorar biblioteca' }).click();
  await page.getByText('120 sons', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Favoritar Pop!' }).click();
  await page.getByRole('button', { name: 'Remover dos favoritos Pop!' }).waitFor();
  await page.getByRole('link', { name: 'Favoritos', exact: true }).click();
  await page.getByText('1 som', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Pop!' }).waitFor();
  await page.goto(origin + '/sounds');
  await page.getByText('120 sons', { exact: true }).waitFor();
  await checkA11y('Sound library accessibility');
  await page.getByRole('combobox', { name: 'Categoria' }).selectOption('games');
  await page.getByText('15 sons', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Licença' }).selectOption('CC0-1.0');
  await page.getByRole('textbox', { name: 'Buscar sons por nome ou tag' }).fill('bonus');
  await page.getByText('1 som', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reproduzir Bônus desbloqueado' }).click();
  await page.getByRole('button', { name: 'Parar Bônus desbloqueado' }).waitFor();
  await page.getByRole('link', { name: 'Usar som' }).click();
  await page.getByText('Som adicionado ao projeto.').waitFor();
  await page.getByText('Salvo na conta').waitFor();
  console.log('PASS landing, locale, catalog filters, playback and sound-to-Studio flow');

  const mediaInput = page.locator('input[type=file]').first();
  await mediaInput.setInputFiles(invalidImage);
  await page.getByText(/SW-1001/).waitFor();
  await mediaInput.setInputFiles(join(files, 'transparency.png'));
  await page.getByRole('button', { name: 'transparency.png', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Nome do projeto' }).fill('Composição QA');
  await page.getByRole('button', { name: 'Texto', exact: true }).click();
  await page.getByRole('textbox', { name: 'Texto da figurinha' }).fill('StickerWave');
  await page.getByRole('button', { name: 'Desfazer' }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Texto da figurinha' }).inputValue(), '');
  await page.getByRole('button', { name: 'Refazer' }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Texto da figurinha' }).inputValue(), 'StickerWave');
  await page.getByText('Salvo na conta').waitFor();
  const originalUrl = page.url();
  await page.reload();
  await page.getByRole('button', { name: 'transparency.png', exact: true }).waitFor();
  assert.match(page.url(), /\/studio\/[0-9a-f-]{36}$/);
  assert.equal(await page.getByRole('textbox', { name: 'Nome do projeto' }).inputValue(), 'Composição QA');
  await page.getByRole('button', { name: 'Texto', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Texto da figurinha' }).inputValue(), 'StickerWave');
  await checkA11y('Studio accessibility');
  await page.screenshot({ path: outputs + '/studio.png', fullPage: true });
  await page.getByRole('button', { name: 'Áudio', exact: true }).click();
  const end = page.getByRole('spinbutton', { name: 'Fim (s)' });
  await end.fill('0.55');
  await end.press('Tab');
  const start = page.getByRole('spinbutton', { name: 'Início (s)' });
  await start.fill('0.15');
  await start.press('Tab');
  await page.getByText('Salvo na conta').waitFor();
  await page.getByRole('button', { name: 'Reproduzir', exact: true }).click();
  await page.getByRole('button', { name: 'Parar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reproduzir', exact: true }).waitFor();
  console.log('PASS import and rejection, caption, undo/redo, IndexedDB recovery, trim and playback');

  async function exportFile(type, extension, container) {
    await page.getByRole('button', { name: 'Exportar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Exportar criação' });
    await dialog.getByRole('radio', { name: new RegExp(type) }).check();
    if (container) await dialog.getByRole('button', { name: container, exact: true }).click();
    await dialog.getByRole('button', { name: 'Exportar', exact: true }).click();
    await dialog.getByText('Arquivo pronto').waitFor({ timeout: 18000 });
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('link', { name: 'Baixar arquivo' }).click()]);
    const destination = outputs + '/test.' + extension;
    await download.saveAs(destination);
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    return destination;
  }
  const image = await exportFile('Imagem WebP', 'webp');
  const wave = await exportFile('Áudio WAV', 'wav');
  for (const [path, stream] of [[image, 'video'], [wave, 'audio']]) {
    const description = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], { encoding: 'utf-8' })).streams;
    assert.equal(description[0].codec_type, stream);
    if (stream === 'audio') {
      assert.equal(description[0].codec_name, 'pcm_s16le');
      assert.equal(description[0].sample_rate, '48000');
      assert(Math.abs(Number(description[0].duration) - .4) < .01);
    } else {
      assert.equal(description[0].codec_name, 'webp');
      assert.equal(description[0].width, 512);
      assert.equal(description[0].height, 512);
      assert.match(description[0].pix_fmt, /a/);
    }
  }
  console.log('PASS WebP alpha/512 and WAV PCM16/48 kHz trimmed output');

  await mediaInput.setInputFiles(join(files, 'video.webm'));
  await page.getByRole('button', { name: 'video.webm', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Exportar', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'Exportar criação' });
  await options.getByRole('radio', { name: /Vídeo com som/ }).check();
  const formats = [];
  for (const container of ['MP4', 'WebM']) {
    if (await options.getByRole('button', { name: container, exact: true }).count()) formats.push(container);
  }
  await options.getByRole('button', { name: 'Fechar' }).click();
  assert(formats.length);
  for (const container of formats) {
    const extension = container.toLowerCase();
    const file = await exportFile('Vídeo com som', extension, container);
    const video = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf-8' })).streams;
    assert(video.some(track => track.codec_type === 'audio'));
    assert(video.some(track => track.codec_type === 'video' && track.width === 512 && track.height === 512));
    const samples = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    let peak = 0;
    for (let offset = 0; offset + 2 <= samples.length; offset += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(offset)));
    assert(peak > 100, 'The exported audio track contains the selected sound');
    console.log('PASS', container, 'video generated in Chromium and verified through ffprobe');
  }
  await page.getByRole('button', { name: 'Exportar', exact: true }).click();
  const cancellation = page.getByRole('dialog', { name: 'Exportar criação' });
  await cancellation.getByRole('radio', { name: /Vídeo com som/ }).check();
  await cancellation.getByRole('button', { name: 'Exportar', exact: true }).click();
  await cancellation.getByRole('button', { name: 'Cancelar exportação' }).click();
  await cancellation.getByText(/SW-3002/).waitFor();
  await cancellation.getByRole('button', { name: 'Fechar' }).click();
  console.log('PASS video export cancellation and editor recovery');

  const backup = await exportFile('Backup do projeto', 'stickerwave.zip');
  await page.getByRole('link', { name: 'Meus projetos' }).click();
  await page.locator('input[type=file]').setInputFiles(backup);
  await page.getByText('Backup restaurado como um novo projeto.').waitFor();
  assert.notEqual(page.url().split('?')[0], originalUrl);
  assert.equal(await page.getByRole('textbox', { name: 'Nome do projeto' }).inputValue(), 'Composição QA');
  await page.getByRole('button', { name: 'Texto', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Texto da figurinha' }).inputValue(), 'StickerWave');
  console.log('PASS backup round-trip with original media');

  await page.getByRole('button', { name: 'Áudio', exact: true }).click();
  await page.getByRole('button', { name: 'Gravar voz' }).click();
  await page.getByText('Gravando…').waitFor();
  await page.waitForFunction(() => window.qaMicTracks.length && window.qaMicTracks[0].readyState === 'live');
  await new Promise(resolve => setTimeout(resolve, 450));
  await page.getByRole('button', { name: 'Parar gravação' }).click();
  await page.getByRole('heading', { name: /Gravação\.(webm|m4a|ogg)/ }).waitFor();
  await page.waitForFunction(() => window.qaMicTracks.every(track => track.readyState === 'ended'));
  console.log('PASS synthetic microphone capture and track cleanup');

  await page.goto(origin + '/studio');
  const orientationInput = page.locator('input[type=file]').first();
  const expectedOrientation = [
    [0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1],
    [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2],
  ];
  for (const [index, expected] of expectedOrientation.entries()) {
    await orientationInput.setInputFiles(join(files, 'exif-' + (index + 1) + '.jpg'));
    await page.waitForFunction(pattern => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return false;
      const palette = [[237,32,32], [32,208,64], [32,48,237], [236,229,44]];
      const sample = [[165,165], [347,165], [165,347], [347,347]];
      const context = canvas.getContext('2d');
      return sample.every(([x, y], i) => {
        const pixel = context.getImageData(x, y, 1, 1).data;
        const sum = color => color.reduce((total, value, c) => total + Math.abs(value - pixel[c]), 0);
        return pixel[3] === 255 && sum(palette[pattern[i]]) < 35;
      });
    }, expected);
  }
  console.log('PASS eight EXIF orientations applied once');

  await page.goto(origin + '/studio');
  const betaInput = page.locator('input[type=file]').first();
  await betaInput.setInputFiles([join(files, 'layer.png'), join(files, 'layer-top.png')]);
  await page.getByRole('button', { name: 'layer.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Camadas', exact: true }).click();
  await page.getByRole('combobox', { name: 'Arquivo da camada' }).selectOption({ label: 'layer-top.png' });
  await page.getByRole('button', { name: 'Adicionar camada de mídia' }).click();
  const blueVisible = () => {
    const pixel = document.querySelector('canvas').getContext('2d').getImageData(256, 256, 1, 1).data;
    return pixel[2] > 210 && pixel[0] < 80;
  };
  await page.waitForFunction(blueVisible);
  await page.getByRole('button', { name: 'Ocultar camada layer-top.png' }).click();
  await page.waitForFunction(() => document.querySelector('canvas').getContext('2d').getImageData(256, 256, 1, 1).data[0] > 190);
  await page.getByRole('button', { name: 'Mostrar camada layer-top.png' }).click();
  await page.getByRole('button', { name: 'Descer camada layer-top.png' }).click();
  await page.waitForFunction(() => document.querySelector('canvas').getContext('2d').getImageData(256, 256, 1, 1).data[0] > 190);
  await page.getByRole('button', { name: 'Subir camada layer-top.png' }).click();
  await page.waitForFunction(blueVisible);
  await page.getByRole('button', { name: 'Adicionar camada de texto' }).click();
  await page.getByRole('textbox', { name: 'Texto da figurinha' }).fill('Camada QA');
  await page.getByText('Salvo na conta').waitFor();
  console.log('PASS canvas layer ordering, visibility, and persisted text');

  const recordings = page.locator('input[type=file]').nth(1);
  for (const name of ['pop.wav','sparkle.wav','tada.wav','rain.wav']) {
    await recordings.setInputFiles(fileURLToPath(new URL('../public/sounds/' + name, import.meta.url)));
    await page.getByRole('heading', { name, exact: true }).waitFor();
  }
  assert.equal(await page.getByRole('combobox', { name: 'Faixa de áudio' }).locator('option').count(), 4);
  assert.equal(await page.getByRole('button', { name: 'Importar áudio', exact: true }).isEnabled(), false);
  await page.getByRole('checkbox', { name: 'Normalizar pico' }).check();
  const offset = page.getByRole('spinbutton', { name: 'Posição na timeline (s)' });
  await offset.fill('0.3'); await offset.press('Tab');
  await page.getByText('Salvo na conta').waitFor();
  const opus = await exportFile('Áudio OGG/Opus', 'ogg');
  const stream = execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name','-of','csv=p=0',opus], { encoding: 'utf8' }).trim();
  assert.equal(stream, 'opus');
  await page.getByRole('button', { name: 'Guardar na biblioteca' }).click();
  await page.getByText('Som guardado na sua biblioteca.').waitFor();
  const betaBackup = await exportFile('Backup do projeto', 'beta.stickerwave.zip');
  await page.getByRole('link', { name: 'Meus projetos' }).click();
  await page.locator('input[type=file]').setInputFiles(betaBackup);
  await page.getByText('Backup restaurado como um novo projeto.').waitFor();
  await page.getByRole('button', { name: 'Camadas', exact: true }).click();
  await page.getByRole('button', { name: 'Camada QA', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Áudio', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Faixa de áudio' }).locator('option').count(), 4);
  console.log('PASS four audio tracks, Opus export and v2 backup round-trip');

  await page.goto(origin + '/projects');
  await page.locator('input[type=file]').setInputFiles(join(files, 'v1.stickerwave.zip'));
  await page.getByText('Backup restaurado como um novo projeto.').waitFor();
  await page.getByRole('button', { name: 'Texto', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Texto da figurinha' }).inputValue(), 'StickerWave');
  console.log('PASS restoring an original 2.0/P0 archive');
  
  await page.goto(origin + '/favorites');
  await page.getByRole('button', { name: 'Minha biblioteca' }).click();
  await page.getByRole('heading', { name: 'rain.wav' }).waitFor();

  for (const name of ['motion.gif','motion.png','motion.webp','image.avif','image.bmp','image.ico','pages.tiff','pages.heic','safe.svg']) {
    await page.goto(origin + '/studio');
    await page.locator('input[type=file]').first().setInputFiles(join(files, name));
    await page.getByRole('button', { name, exact: true }).waitFor({ timeout: 20000 });
    if (name.startsWith('motion')) {
      await page.getByRole('checkbox', { name: 'Animar mídia na composição' }).uncheck();
      await page.getByRole('slider', { name: /Quadro/ }).press('End');
      await page.waitForFunction(blueVisible);
      await page.getByRole('checkbox', { name: 'Animar mídia na composição' }).check();
      if (name === 'motion.gif') {
        const exported = await exportFile('WebP animado', 'animated.webp');
        const input = page.locator('input[type=file]').first();
        await input.setInputFiles(exported);
        await page.getByRole('button', { name: 'test.animated.webp', exact: true }).waitFor();
        await page.getByRole('checkbox', { name: 'Animar mídia na composição' }).waitFor();
      }
    }
    if (name.startsWith('pages')) {
      await page.getByRole('slider', { name: /Página/ }).press('End');
      await page.waitForFunction(blueVisible);
    }
  }
  await page.locator('input[type=file]').first().setInputFiles(join(files, 'unsupported.svg'));
  await page.getByText(/SW-1006/).waitFor();
  await page.goto(origin + '/studio');
  await page.locator('input[type=file]').first().setInputFiles(join(files, 'video.webm'));
  await page.getByRole('button', { name: 'Extrair áudio do vídeo' }).click();
  await page.getByRole('heading', { name: 'video.wav', exact: true }).waitFor({ timeout: 30000 });
  console.log('PASS GIF, APNG, animated WebP, AVIF, BMP, ICO, TIFF, HEIC, safe SVG and audio extraction');

  await page.goto(origin + '/studio');
  await page.getByRole('button', { name: 'Editar um exemplo' }).waitFor();
  const pasteImage = await page.evaluate(async url => {
    const payload = new DataTransfer();
    const original = await fetch(url).then(response => response.blob());
    payload.items.add(new File([original], 'clipboard.png', { type: 'image/png' }));
    return !document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: payload, bubbles: true, cancelable: true }));
  }, origin + '/images/app-192.png');
  assert.equal(pasteImage, true);
  await page.getByRole('button', { name: 'clipboard.png', exact: true }).waitFor();
  console.log('PASS clipboard image import');

  await page.goto(origin + '/studio');
  await page.locator('input[type=file]').first().setInputFiles(join(files, 'sync.webm'));
  await page.getByRole('button', { name: 'Extrair áudio do vídeo' }).click();
  await page.getByRole('heading', { name: 'sync.wav', exact: true }).waitFor({ timeout: 30000 });
  const synchronized = await exportFile('Vídeo com som', 'sync.' + formats[0].toLowerCase(), formats[0]);
  const light = execFileSync('ffmpeg', ['-v','error','-i',synchronized,'-map','0:v:0','-vf','crop=2:2,scale=1:1,format=gray,fps=24','-threads','1','-f','rawvideo','-']);
  const pcm = execFileSync('ffmpeg', ['-v','error','-i',synchronized,'-map','0:a:0','-ac','1','-af','aresample=8000:async=1000:min_hard_comp=0.001:first_pts=0','-f','s16le','-']);
  const bright = light.findIndex(pixel => pixel > 160);
  let audible = -1;
  for (let off = 0; off + 2 <= pcm.length; off += 2) {
    if (Math.abs(pcm.readInt16LE(off)) > 2200) { audible = off / 2; break; }
  }
  assert(bright >= 0 && audible >= 0);
  const drift = Math.abs(bright / 24 - audible / 8000);
  assert(drift <= .1, `Sound and picture drift ${(drift * 1000).toFixed(1)} ms`);
  console.log('PASS audiovisual synchronization fixture,', (drift * 1000).toFixed(1), 'ms drift');

  await page.goto(origin);
  await page.getByRole('button', { name: 'Escuro' }).first().click();
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await checkA11y('Dark landing accessibility');
  await page.goto(origin + '/studio');
  await page.getByRole('button', { name: 'Editar um exemplo' }).waitFor();
  await checkA11y('Dark studio accessibility');
  await page.getByRole('button', { name: 'Editar um exemplo' }).click();
  await page.getByRole('button', { name: 'Prévia WhatsApp' }).click();
  await page.getByRole('button', { name: 'Toque na figurinha para ouvir o som' }).waitFor();
  await checkA11y('Dark studio WhatsApp preview accessibility');
  await page.getByRole('button', { name: 'Estúdio' }).click();
  await page.goto(origin);
  await page.getByRole('button', { name: 'Claro' }).first().click();

  await page.goto(origin + '/sounds');
  await page.getByRole('button', { name: 'Reproduzir Pop!' }).click();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(async () => Boolean(await caches.match('/sounds/pop.wav')));
  await context.setOffline(true);
  await page.goto(origin + '/sounds');
  await page.getByText('120 sons', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reproduzir Pop!' }).click();
  await page.getByRole('button', { name: 'Parar Pop!' }).waitFor();
  await page.goto(origin + '/studio');
  await page.getByRole('button', { name: 'Editar um exemplo' }).waitFor();
  await context.setOffline(false);
  console.log('PASS dark theme, install assets and cached offline routes/audio');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: outputs + '/mobile.png', fullPage: true });
  await page.getByRole('link', { name: 'Criar figurinha' }).click();
  await page.getByRole('button', { name: 'Editar um exemplo' }).click();
  await page.getByText('Salvo na conta').waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(await page.getByRole('button', { name: 'Exportar', exact: true }).isEnabled());
  console.log('PASS mobile viewport layout and example flow');
  console.log('PASS automated accessibility rules on landing, catalog and Studio');
  assert.deepEqual(jsErrors, []);
  assert.deepEqual(offOrigin, []);
  assert.deepEqual(writes, []);
  console.log('PASS no unexpected JS exceptions, cross-origin requests or uploads');
} catch (error) {
  const pages = browser?.contexts().flatMap(context => context.pages()) ?? [];
  for (const page of pages) {
    console.error('Final URL', page.url());
    console.error((await page.locator('body').innerText()).slice(0, 5500));
    await page.screenshot({ path: outputs + '/failure.png', fullPage: true }).catch(() => undefined);
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(browserDbDir, { recursive: true, force: true }).catch(() => undefined);
}
