import { useEffect, useRef, useState } from 'react';
import { AudioLines, BookOpen, CircleHelp, Code2, Download, FileArchive, Folder, FolderOpen, Globe2, ImagePlus,
  LogOut, Menu, Mic, Plus, ScanLine, ShieldCheck, Sparkles, Trash2, Upload, User, X } from 'lucide-react';
import { Brand, Modal, Notice } from '../app/shared';
import { Link, useApp } from '../app/context';
import { Wavi } from './wavi';
import { ThemeControl, InstallControl } from './preferences';
import { FeaturedSounds } from './sounds';
import { errorCode, type ErrorCode } from '../locales';
import { listProjects, removeProject, save } from '../infrastructure/storage';
import type { Project } from '../core/project';
import { videoFormats, audioFormats } from '../infrastructure/media';

export function Header() {
  const { copy, locale, path, toggleLanguage, user, logout } = useApp();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  const firstName = user?.name.split(/\s+/)[0];
  return <header className="site-header">
    <div className="wrap topbar">
      <Brand />
      <nav className={`site-nav ${open ? 'nav-open' : ''}`} aria-label={locale === 'pt' ? 'Navegação principal' : 'Main navigation'}>
        <Link href="/sounds" aria-current={path === '/sounds' ? 'page' : undefined}>{copy.sounds}</Link>
        <Link href="/projects" aria-current={path === '/projects' ? 'page' : undefined}>{copy.projects}</Link>
        <Link href="/contribute" aria-current={path === '/contribute' ? 'page' : undefined}><Code2 size={17} />{copy.contribute}</Link>
        {!user && <Link className="nav-mobile-auth" href="/auth" aria-current={path === '/auth' ? 'page' : undefined}><User size={16} />{copy.signIn}</Link>}
        {user && <button type="button" className="text-button nav-mobile-auth" onClick={() => void logout()}>{copy.signOut} ({firstName})</button>}
      </nav>
      <div className="nav-actions">
        <ThemeControl />
        <button className="language" aria-label={`${locale.toUpperCase()} · ${copy.language}`} onClick={toggleLanguage}><Globe2 size={16} />{locale === 'pt' ? 'PT' : 'EN'}</button>
        {user ? <>
          <Link className="button button-outline nav-auth" href="/auth"><User size={16} />{firstName}</Link>
          <button type="button" className="icon-button nav-auth" title={copy.signOut} aria-label={copy.signOut} onClick={() => void logout()}><LogOut size={17} /></button>
        </> : <Link className="button button-outline nav-auth" href="/auth"><User size={16} />{copy.signIn}</Link>}
        {path !== '/' && <Link className="button button-green nav-create" href="/studio"><Plus size={17} />{copy.newProject}</Link>}
        <button className="icon-button menu-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={open ? copy.close : copy.openMenu}>{open ? <X /> : <Menu />}</button>
      </div>
    </div>
  </header>;
}

export function Footer() {
  const { copy } = useApp();
  return <footer className="site-footer">
    <div className="wrap footer-inner">
      <div><Brand /><p>{copy.footer}</p><div className="button-row footer-preferences"><ThemeControl /><InstallControl /></div></div>
      <nav aria-label={copy.about}>
        {(['docs', 'privacy', 'licenses', 'contribute', 'about'] as const).map(item => <Link key={item} href={`/${item}`}>{copy[item]}</Link>)}
      </nav>
    </div>
  </footer>;
}

export function Landing() {
  const { copy } = useApp();
  const [meter, setMeter] = useState({ active: false, level: 0, bass: 0 });
  return <>
    <section className="wrap hero">
      <div className="hero-copy">
        <p className="eyebrow hero-label"><AudioLines size={18} />{copy.heroLabel}</p>
        <h1>{copy.heroTitle}<br /><span>{copy.heroSecond}</span></h1>
        <p className="hero-description">{copy.heroBody}</p>
        <Link className="button button-green hero-cta" href="/studio"><Sparkles size={21} />{copy.create}</Link>
        <div className="hero-details"><span><ShieldCheck size={17} />{copy.local}</span><span><ScanLine size={17} />{copy.free}</span></div>
      </div>
      <Wavi state={meter.active ? 'Dance' : 'Idle'} level={meter.level} bass={meter.bass} />
    </section>
    <FeaturedSounds onAudio={setMeter} />
    <section className="wrap how">
      <p className="eyebrow">{copy.stepsLabel}</p><h2>{copy.stepsTitle}</h2>
      <div className="step-grid">
        {([[ImagePlus, copy.step1, copy.step1Body], [Mic, copy.step2, copy.step2Body], [Download, copy.step3, copy.step3Body]] as const).map(([Icon, title, body]) =>
          <article key={title}><div className="step-icon"><Icon size={25} /></div><h3>{title}</h3><p>{body}</p></article>)}
      </div>
    </section>
    <section className="wrap"><div className="privacy-band"><ShieldCheck size={34} /><div><h2>{copy.privateTitle}</h2><p>{copy.privateBody}</p></div>
      <Link className="button button-outline" href="/privacy">{copy.privacy}</Link></div></section>
  </>;
}

export function ProjectsPage() {
  const { copy, locale, navigate } = useApp();
  const [projects, setProjects] = useState<Project[]>();
  const [pending, setPending] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<ErrorCode>();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    listProjects().then(data => { if (active) setProjects(data); }).catch(() => { if (active) setNotice('4001'); });
    return () => { active = false; controller.current?.abort(); };
  }, []);
  async function restore(file?: File) {
    if (!file || controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setNotice(undefined);
    setRestoring(true);
    try {
      const { readBackup } = await import('../infrastructure/backup');
      const { project, assets } = await readBackup(file, operation.signal);
      operation.signal.throwIfAborted();
      const result = await save({ ...project, id: crypto.randomUUID(), revision: 0 }, assets, null);
      if (!operation.signal.aborted) navigate(`/studio/${result.id}?restored=1`);
    } catch (error) { if (!operation.signal.aborted) setNotice(errorCode(error, '4002')); }
    finally { controller.current = null; setRestoring(false); }
  }
  async function confirmDelete() {
    try {
      await removeProject(pending === 'all' ? undefined : pending ?? undefined);
      setProjects(await listProjects());
      setNotice(undefined);
    } catch (error) { setNotice(errorCode(error, '4001')); }
    finally { setPending(null); }
  }
  return <section className="wrap page projects-page">
    <p className="eyebrow"><FolderOpen size={18} />{copy.drafts}</p>
    <div className="section-heading">
      <div><h1>{copy.projectsTitle}</h1><p className="page-intro">{copy.projectsBody}</p></div>
      <div className="button-row">
        <button className="button button-outline" onClick={() => input.current?.click()} disabled={restoring}><Upload size={17} />{copy.restore}</button>
        <Link className="button button-green" href="/studio"><Plus size={18} />{copy.newProject}</Link>
      </div>
    </div>
    <input hidden ref={input} type="file" accept=".zip,application/zip" aria-label={copy.restore} onChange={event => {
      void restore(event.currentTarget.files?.[0]); event.currentTarget.value = '';
    }} />
    {restoring && <Notice><span>{copy.restoring}</span><button className="text-button" onClick={() => controller.current?.abort()}>{copy.cancel}</button></Notice>}
    {notice && <Notice error>{copy.errors[notice]} [SW-{notice}]</Notice>}
    {!projects && !notice && <p role="status">{copy.loading}</p>}
    {projects?.length === 0 && <div className="empty project-empty"><Folder size={34} /><h2>{copy.emptyProjects}</h2><p>{copy.emptyProjectsBody}</p></div>}
    {!!projects?.length && <>
      <div className="project-list">{projects.map(project => <article key={project.id} className="project-row">
        <div className="project-symbol"><Folder size={23} /></div>
        <div><h2>{project.name}</h2><time dateTime={project.updatedAt}>{new Intl.DateTimeFormat(locale === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(project.updatedAt))}</time></div>
        <Link className="button button-outline button-small" href={`/studio/${project.id}`}>{copy.open}</Link>
        <button className="icon-button" aria-label={`${copy.delete} ${project.name}`} onClick={() => setPending(project.id)}><Trash2 size={18} /></button>
      </article>)}</div>
      <button className="button button-outline danger delete-all" onClick={() => setPending('all')}><Trash2 size={17} />{copy.deleteAll}</button>
    </>}
    {pending && <Modal title={pending === 'all' ? copy.deleteAllTitle : copy.deleteOneTitle} close={() => setPending(null)}>
      <p>{pending === 'all' ? copy.deleteAllBody : copy.deleteBody}</p>
      <div className="button-row modal-actions"><button className="button button-outline" onClick={() => setPending(null)}>{copy.cancel}</button>
        <button className="button button-danger" onClick={() => void confirmDelete()}><Trash2 size={17} />{copy.delete}</button></div>
    </Modal>}
  </section>;
}

const editorial = {
  pt: {
    docs: [
      ['Importar e editar', 'No Studio, selecione, arraste ou cole mídia. Use Mídia para ajustar recortes e escolher o quadro ou a página. Camadas reúne mídia e texto e permite alterar ordem e visibilidade.'],
      ['Adicionar áudio', 'Use a biblioteca, importe áudio, extraia uma pista de vídeo ou grave com o microfone onde houver suporte. A aba Áudio edita até quatro faixas e permite ajustar posição, recorte, volume, velocidade e fades.'],
      ['Baixar ou restaurar', 'Exporte WebP estático ou animado, WAV, OGG/Opus, vídeo MP4/WebM ou ZIP. Meus projetos restaura o ZIP como um novo projeto. Em caso de incompatibilidade de codec, escolha outro formato na exportação.'],
      ['Instalar e usar offline', 'Instale o StickerWave pelo navegador compatível. Abra o editor online uma vez. O editor e os sons já carregados ficam disponíveis enquanto estiverem no cache local.'],
      ['Atalhos', 'Use Ctrl/⌘+Z para desfazer e Ctrl/⌘+Shift+Z ou Ctrl/⌘+Y para refazer. Pressione Espaço fora de um controle para reproduzir ou parar.'],
    ],
    privacy: [
      ['Conta e metadados', 'Cadastro gratuito com nome, e-mail e senha protegida (hash scrypt com sal e sessão em cookie HttpOnly). Rascunhos em JSON leve e favoritos ficam salvos via Prisma/SQLite no servidor.'],
      ['Mídias locais no aparelho', 'Imagens, vídeos, áudios importados e gravações continuam processados e guardados no IndexedDB do seu navegador (por conta) — sem upload de arquivos pesados para o servidor.'],
      ['Microfone e retenção', 'A captura só começa após você clicar em Gravar voz e autorizar. Use Meus projetos para apagar rascunhos ou backups ZIP para portabilidade entre aparelhos.'],
    ],
    licenses: [
      ['Código', 'O código-fonte do StickerWave usa a licença MIT. As dependências mantêm suas próprias licenças.'],
      ['Sons', 'Os efeitos fornecidos foram sintetizados para este projeto e disponibilizados sob CC0 1.0. Origem e autoria aparecem em cada item do catálogo.'],
      ['Arquivos próprios', 'Use somente mídias que você tem permissão para editar e compartilhar. O projeto preserva seus arquivos originais.'],
    ],
    contribute: [
      ['Código e documentação', 'O pacote do projeto contém instruções para instalar, testar e compilar o StickerWave. Propostas devem incluir passos reproduzíveis e um exemplo sem dados pessoais.'],
      ['Sons originais', 'Abra um PR com autoria, declaração de direitos, licença, duração e tags. Preserve o WAV original, atualize o hash no catálogo e inclua a evidência de validação.'],
    ],
    about: [
      ['StickerWave', 'Um estúdio web para combinar imagem, legenda e som. O Wavi é o mascote do projeto.'],
      ['Compatibilidade', 'A disponibilidade de codecs varia por navegador. Veja o diagnóstico abaixo e use uma saída compatível com o seu dispositivo. A integração nativa com o WhatsApp está em fase de pesquisa.'],
    ],
  },
  en: {
    docs: [
      ['Import and edit', 'In Studio, select, drop or paste media. Use Media to crop and pick a frame or page. Layers lets you arrange media and text, and change their visibility.'],
      ['Add audio', 'Choose a library sound, import audio, extract a video track or record with the microphone where supported. Edit offsets, trim, volume, playback speed and fades for up to four tracks.'],
      ['Download or restore', 'Export still or animated WebP, WAV, OGG/Opus, MP4/WebM video or ZIP. My projects restores the ZIP as a new project. Choose another format if a codec is unavailable.'],
      ['Install and work offline', 'Install StickerWave from a supported browser. Open Studio online first. The editor and previously loaded sounds work while available in local cache.'],
      ['Keyboard shortcuts', 'Use Ctrl/⌘+Z to undo and Ctrl/⌘+Shift+Z or Ctrl/⌘+Y to redo. Press Space outside a control to play or stop.'],
    ],
    privacy: [
      ['Account and metadata', 'Free sign-up stores your name, email, salted scrypt password hash, HttpOnly session cookie, lightweight project JSON and favorites via Prisma/SQLite.'],
      ['On-device media', 'Heavy images, videos, imported audio and voice recordings stay processed and stored inside browser IndexedDB (scoped per user account) — zero heavy server media uploads.'],
      ['Microphone and retention', 'Capture runs only after you click Record voice and grant access. Delete projects in My projects or export ZIP backups to move originals across devices.'],
    ],
    licenses: [
      ['Code', 'StickerWave source code uses the MIT license. Dependencies have their own licenses.'],
      ['Sounds', 'The included effects were synthesized for this project and are available under CC0 1.0. Source and author appear in every library entry.'],
      ['Your files', 'Use media you have permission to edit and share. Projects preserve your original files.'],
    ],
    contribute: [
      ['Code and documentation', 'The project package includes installation, test and build instructions. Proposals should include reproducible steps and a sample free of personal data.'],
      ['Original sounds', 'Open a pull request with the author, rights declaration, license, duration and tags. Keep the original WAV, update the catalog hash and include validation results.'],
    ],
    about: [
      ['StickerWave', 'A web studio for combining images, captions and sound. Wavi is the project mascot.'],
      ['Compatibility', 'Codec availability varies by browser. Check the diagnostics below and choose an output your device supports. Native WhatsApp integration is under research.'],
    ],
  },
};
export type EditorialPage = keyof typeof editorial.pt;

export function capabilities() {
  return {
    'WebP Encode': (() => {
      try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); }
      catch { return false; }
    })(),
    'MP4 Encode': (typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined') || videoFormats().some(type => type.startsWith('video/mp4')),
    'WebM Encode': videoFormats().some(type => type.startsWith('video/webm')),
    'Web Audio': typeof OfflineAudioContext !== 'undefined',
    'MediaRecorder': audioFormats().length > 0,
    'Microphone': Boolean(navigator.mediaDevices?.getUserMedia),
    'Web Share': Boolean(navigator.canShare),
    'IndexedDB': typeof indexedDB !== 'undefined',
    'Worker': typeof Worker !== 'undefined',
    'ImageDecoder': 'ImageDecoder' in globalThis,
    'WebAssembly': typeof WebAssembly !== 'undefined',
    'Service Worker': 'serviceWorker' in navigator,
    'WebGL 2': typeof WebGL2RenderingContext !== 'undefined',
  };
}

export function Editorial({ topic }: { topic: EditorialPage }) {
  const { copy, locale } = useApp();
  const Icon = { docs: BookOpen, privacy: ShieldCheck, licenses: FileArchive, contribute: Code2, about: CircleHelp }[topic];
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const info = topic === 'about' ? capabilities() : null;
  return <section className="wrap page editorial">
    <p className="eyebrow"><Icon size={18} />StickerWave</p><h1>{copy[topic]}</h1>
    {editorial[locale][topic].map(([title, text]) => <article key={title}><h2>{title}</h2><p>{text}</p></article>)}
    {info && <article><h2>{copy.diagnosticsTitle}</h2>
      <dl className="capabilities">{Object.entries(info).map(([name, available]) => <div key={name}><dt>{name}</dt><dd>{available ? copy.supported : copy.unavailable}</dd></div>)}</dl>
      <button className="button button-outline" onClick={() => void navigator.clipboard.writeText(JSON.stringify({ version: '2.1.0-beta.1', capabilities: info }, null, 2))
        .then(() => { setCopied(true); setFailed(false); }).catch(() => setFailed(true))}>{copy.copyDiagnostic}</button>
      {copied && <p role="status">{copy.copied}</p>}{failed && <Notice error>{copy.errors['4002']}</Notice>}
    </article>}
  </section>;
}
