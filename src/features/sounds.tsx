import { useEffect, useRef, useState } from 'react';
import { AudioLines, Bell, Bird, CloudRain, ExternalLink, Gamepad2, Ghost, Headphones, Heart, Laugh, Play, Plus, Search, Shuffle, Square, Trash2, Upload, Wand2, Zap } from 'lucide-react';
import { Link, useApp } from '../app/context';
import { Bars, Modal, Notice } from '../app/shared';
import { catalog, categories, type Sound } from '../infrastructure/catalog';
import { changeFavorite, favoriteIds, keepSound, personalSounds, removeSound } from '../infrastructure/storage';
import { importMedia } from '../infrastructure/media';
import { errorCode, type ErrorCode } from '../locales';
import type { StoredAsset } from '../core/project';

const icons = { comedy: Laugh, games: Gamepad2, reactions: Zap, interface: Bell, ambient: CloudRain, suspense: Ghost, originals: Wand2, animals: Bird };

const externalMemeLibraries: {
  name: string;
  url: string;
  kind: 'viral' | 'free';
  pt: string;
  en: string;
}[] = [
  {
    name: 'Myinstants',
    url: 'https://www.myinstants.com',
    kind: 'viral',
    pt: 'Maior soundboard colaborativo de memes brasileiros e mundiais com download em MP3.',
    en: 'Largest community soundboard of viral Brazilian and global meme clips in MP3.',
  },
  {
    name: 'Voicemod Tuna',
    url: 'https://tuna.voicemod.net',
    kind: 'viral',
    pt: 'Biblioteca comunitária focada em áudios curtos de memes, animes e games.',
    en: 'Community library dedicated to short meme audio clips, anime cues, and game SFX.',
  },
  {
    name: '101 Soundboards',
    url: 'https://www.101soundboards.com',
    kind: 'viral',
    pt: 'Boards temáticos de memes clássicos, séries, streamers e jogos para baixar.',
    en: 'Themed soundboards for classic memes, shows, streamers, and game voice lines.',
  },
  {
    name: 'Pixabay Sound Effects',
    url: 'https://pixabay.com/sound-effects',
    kind: 'free',
    pt: 'Impactos estilo vine boom, transições e comédia grátis sem atribuição obrigatória.',
    en: 'Free hits, transitions, and comedy effects with no attribution required.',
  },
  {
    name: 'Freesound (CC0)',
    url: 'https://freesound.org',
    kind: 'free',
    pt: 'Base colaborativa mundial; use o filtro Creative Commons 0 para WAV/MP3 em domínio público.',
    en: 'Collaborative audio repository; filter by Creative Commons 0 for public-domain WAV/MP3.',
  },
  {
    name: 'Mixkit Sound Effects',
    url: 'https://mixkit.co/free-sound-effects',
    kind: 'free',
    pt: 'Efeitos curtos, jingles e sons estilo cartoon livres de royalties sem cadastro.',
    en: 'Royalty-free short SFX, jingles, and cartoon cues with no sign-up required.',
  },
  {
    name: 'Kenney Audio',
    url: 'https://kenney.nl',
    kind: 'free',
    pt: 'Pacotes inteiros em CC0 1.0 com cliques de interface, impactos e jingles prontos.',
    en: 'Full CC0 1.0 packs featuring interface pops, impacts, and arcade jingles.',
  },
  {
    name: 'Lots of Sounds & wyzowl/sfx-kit',
    url: 'https://github.com/wyzowl/sfx-kit',
    kind: 'free',
    pt: 'Coleções open source (CC0) em WAV 48 kHz; veja também lotsofsounds.com (12 mil+ efeitos).',
    en: 'Open-source CC0 48 kHz WAV pack; see lotsofsounds.com for 12k+ CC0 soundboard cues.',
  },
];

export function useCatalog() {
  const [sounds, setSounds] = useState<Sound[]>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    catalog().then(data => { if (active) { setSounds(data); setError(false); } }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return { sounds, error, retry: () => setAttempt(value => value + 1) };
}

export type AudioMeter = { active: boolean; level: number; bass: number };

export function useSoundPlayer(onMeter?: (meter: AudioMeter) => void) {
  const [playing, setPlaying] = useState('');
  const [failed, setFailed] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef('');
  const meterRef = useRef(onMeter);
  meterRef.current = onMeter;
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const release = () => { if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = ''; } };
  const stopMeter = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    meterRef.current?.({ active: false, level: 0, bass: 0 });
  };
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    audio.current?.pause();
    audio.current = null;
    release();
    void ctxRef.current?.close().catch(() => undefined);
  }, []);
  function play(sound: Sound | StoredAsset) {
    const previous = audio.current;
    previous?.pause();
    stopMeter();
    release();
    audio.current = null;
    setFailed(false);
    setPlaying('');
    if (playing === sound.id) return;
    if ('blob' in sound) objectUrl.current = URL.createObjectURL(sound.blob);
    const element = new Audio('url' in sound ? sound.url : objectUrl.current);
    audio.current = element;
    let source: MediaElementAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    if (meterRef.current && typeof AudioContext !== 'undefined') {
      try {
        ctxRef.current ??= new AudioContext();
        if (ctxRef.current.state === 'suspended') void ctxRef.current.resume().catch(() => undefined);
        source = ctxRef.current.createMediaElementSource(element);
        analyser = ctxRef.current.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser).connect(ctxRef.current.destination);
      } catch {
        source = undefined;
        analyser = undefined;
      }
    }
    const settle = (error: boolean) => {
      if (audio.current !== element) return;
      audio.current = null;
      setPlaying('');
      setFailed(error);
      stopMeter();
      source?.disconnect();
      analyser?.disconnect();
      release();
    };
    element.addEventListener('ended', () => settle(false), { once: true });
    element.addEventListener('error', () => settle(true), { once: true });
    element.play().then(() => {
      if (audio.current !== element || !meterRef.current) return;
      if (!analyser) { meterRef.current({ active: true, level: 0.45, bass: 0.35 }); return; }
      const timeData = new Uint8Array(analyser.fftSize);
      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const sample = () => {
        if (audio.current !== element) return;
        analyser!.getByteTimeDomainData(timeData);
        analyser!.getByteFrequencyData(freqData);
        let squares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const norm = (timeData[i] - 128) / 128;
          squares += norm * norm;
        }
        const level = Math.min(1, 3.5 * Math.sqrt(squares / timeData.length));
        const bass = (freqData[1] + freqData[2] + freqData[3] + freqData[4]) / (4 * 255);
        meterRef.current?.({ active: true, level, bass });
        rafRef.current = requestAnimationFrame(sample);
      };
      rafRef.current = requestAnimationFrame(sample);
    }).catch(() => settle(true));
    setPlaying(sound.id);
  }
  return { playing, play, failed };
}

export function SoundCard({ sound, playing, play, compact = false, use, favorite, onFavorite, onTag }: {
  sound: Sound; playing: boolean; play: () => void; compact?: boolean; use?: () => void; favorite?: boolean; onFavorite?: () => void; onTag?: (tag: string) => void;
}) {
  const { copy, locale } = useApp();
  const Icon = icons[sound.category];
  const desc = sound.description?.[locale];
  return <article className={`sound-card ${compact ? 'sound-compact' : ''} ${playing ? 'sound-active' : ''}`}>
    <div className="sound-head">
      <div className={`sound-icon sound-${sound.category}`}><Icon size={22} strokeWidth={2} /></div>
      <div className="sound-name"><h3>{sound.name[locale]}</h3><p>{copy[sound.category]} <span>·</span> {(sound.durationMs / 1000).toLocaleString(locale === 'pt' ? 'pt-BR' : 'en-US')} s</p></div>
      {onFavorite && <button className="icon-button sound-favorite" title={favorite ? copy.unfavorite : copy.favorite}
        aria-label={`${favorite ? copy.unfavorite : copy.favorite} ${sound.name[locale]}`} aria-pressed={favorite} onClick={onFavorite}>
        <Heart size={18} fill={favorite ? 'currentColor' : 'none'} /></button>}
      <button className="sound-play" aria-label={`${playing ? copy.stop : copy.play} ${sound.name[locale]}`} aria-pressed={playing} onClick={play}>
        {playing ? <Square size={14} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
    </div>
    {desc && <p className="sound-desc">{desc}</p>}
    <Bars bars={sound.bars} />
    {!compact && sound.tags.length > 0 && onTag && <div className="sound-tags">
      {sound.tags.slice(0, 3).map(tag => <button key={tag} type="button" className="sound-tag" onClick={() => onTag(tag)}>#{tag}</button>)}
    </div>}
    {!compact && <div className="sound-foot">
      <small>{sound.author} · {sound.license}</small>
      {use ? <button className="button button-small" onClick={use}><Plus size={16} />{copy.use}</button>
        : <Link className="button button-small" href={`/studio?sound=${sound.id}`}><Plus size={16} />{copy.use}</Link>}
    </div>}
  </article>;
}

export function FeaturedSounds({ onAudio }: { onAudio?: (meter: AudioMeter) => void } = {}) {
  const { copy } = useApp();
  const { sounds, error, retry } = useCatalog();
  const player = useSoundPlayer(onAudio);
  const featured = ['pop', 'sparkle', 'tada'].flatMap(id => sounds?.find(sound => sound.id === id) ?? []);
  return <section className="sound-shelf">
    <div className="wrap">
      <div className="section-heading">
        <div><p className="eyebrow"><AudioLines size={17} />{copy.sounds}</p><h2>{copy.soundsTitle}</h2><p>{copy.soundsBody}</p></div>
        <Link className="button button-outline" href="/sounds"><Headphones size={18} />{copy.allSounds}</Link>
      </div>
      {(error || player.failed) && <Notice error><span>{copy.catalogError}</span><button className="text-button" onClick={retry}>{copy.retry}</button></Notice>}
      <div className="sound-grid">{featured.map(sound => <SoundCard key={sound.id} sound={sound} compact playing={player.playing === sound.id} play={() => player.play(sound)} />)}</div>
    </div>
  </section>;
}

const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function SoundLibrary({ select, favoritesOnly = false }: { select?: (sound: Sound | StoredAsset) => void; favoritesOnly?: boolean }) {
  const { copy, locale, user, navigate } = useApp();
  const { sounds, error, retry } = useCatalog();
  const player = useSoundPlayer();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [license, setLicense] = useState('all');
  const [lengthFilter, setLengthFilter] = useState('all');
  const [section, setSection] = useState<'catalog' | 'personal'>('catalog');
  const [limit, setLimit] = useState(24);
  const [spotlight, setSpotlight] = useState('');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [personal, setPersonal] = useState<StoredAsset[]>([]);
  const [pending, setPending] = useState<StoredAsset>();
  const [issue, setIssue] = useState<ErrorCode>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    if (!user) { setFavorites([]); setPersonal([]); return; }
    const update = () => {
      void Promise.all([favoriteIds(), personalSounds()]).then(([ids, files]) => {
        if (active) { setFavorites(ids); setPersonal(files); }
      }).catch(() => { if (active) setIssue('4001'); });
    };
    update();
    window.addEventListener('stickerwave:library', update);
    return () => { active = false; window.removeEventListener('stickerwave:library', update); };
  }, [user?.id]);

  async function addFile(file?: File) {
    if (!file || busy) return;
    setBusy(true);
    setIssue(undefined);
    try { await keepSound(await importMedia(file, file.name, 'audio')); }
    catch (error) { setIssue(errorCode(error, '2002')); }
    finally { setBusy(false); }
  }
  function toggle(id: string) {
    if (!user) { navigate('/auth?next=/sounds'); return; }
    void changeFavorite(id, !favorites.includes(id)).catch(() => setIssue('4001'));
  }
  const filtered = sounds?.filter(sound => (!favoritesOnly || favorites.includes(sound.id)) &&
    (category === 'all' || category === sound.category) && (license === 'all' || license === sound.license) &&
    (lengthFilter === 'all' || (lengthFilter === 'short' ? sound.durationMs <= 800 : lengthFilter === 'medium' ? sound.durationMs > 800 && sound.durationMs <= 1500 : sound.durationMs > 1500)) &&
    normalize([sound.name[locale], sound.description?.[locale] ?? '', ...sound.tags].join(' ')).includes(normalize(query.trim())));
  const visiblePersonal = personal.filter(asset => normalize(asset.name).includes(normalize(query.trim())));
  const spotlightSound = spotlight ? filtered?.find(item => item.id === spotlight) : undefined;
  const visibleCatalog = spotlightSound && filtered
    ? [spotlightSound, ...filtered.filter(item => item.id !== spotlightSound.id)].slice(0, limit)
    : filtered?.slice(0, limit);
  function playRandom() {
    if (!filtered?.length) return;
    const pool = filtered.filter(item => item.id !== player.playing);
    const pick = (pool.length ? pool : filtered)[Math.floor(Math.random() * (pool.length ? pool.length : filtered.length))];
    setSpotlight(pick.id);
    player.play(pick);
  }
  return <section className={select ? 'catalog catalog-inline' : 'wrap page catalog'}>
    {!select && <><p className="eyebrow"><Headphones size={18} />StickerWave</p><h1>{favoritesOnly ? copy.favorites : copy.catalogTitle}</h1><p className="page-intro">{copy.catalogBody}</p></>}
    <div className="button-row library-tabs">
      <button className="button button-outline" aria-pressed={section === 'catalog'} onClick={() => setSection('catalog')}>
        {favoritesOnly ? <Heart size={17} /> : <Headphones size={17} />}{favoritesOnly ? copy.favorites : copy.sounds}
      </button>
      <button className="button button-outline" aria-pressed={section === 'personal'} onClick={() => setSection('personal')}><AudioLines size={17} />{copy.personalLibrary}</button>
      {!favoritesOnly && !select && <Link className="button button-outline" href="/favorites"><Heart size={17} />{copy.favorites}</Link>}
      {section === 'catalog' && Boolean(filtered?.length) && <button type="button" className="button button-green" onClick={playRandom}><Shuffle size={17} />{copy.surpriseMe}</button>}
    </div>
    {section === 'catalog' && <div className="category-pills" role="group" aria-label={copy.category}>
      <button type="button" className="category-pill" aria-pressed={category === 'all'} onClick={() => { setCategory('all'); setLimit(24); }}>{copy.all}</button>
      {categories.map(key => {
        const Icon = icons[key];
        return <button key={key} type="button" className={`category-pill pill-${key}`} aria-pressed={category === key}
          onClick={() => { setCategory(key); setLimit(24); }}><Icon size={15} />{copy[key]}</button>;
      })}
    </div>}
    <div className="filters">
      <label className="search"><Search size={20} /><input aria-label={copy.search} value={query} onChange={event => { setQuery(event.target.value); setLimit(24); }} placeholder={copy.search} /></label>
      {section === 'catalog' && <><label>{copy.category}<select value={category} onChange={event => { setCategory(event.currentTarget.value); setLimit(24); }}><option value="all">{copy.all}</option>{categories.map(key => <option key={key} value={key}>{copy[key]}</option>)}</select></label>
      <label>{copy.durationFilter}<select value={lengthFilter} onChange={event => { setLengthFilter(event.currentTarget.value); setLimit(24); }}><option value="all">{copy.all}</option>
        <option value="short">{copy.durationShort}</option><option value="medium">{copy.durationMedium}</option><option value="long">{copy.durationLong}</option></select></label>
      <label>{copy.license}<select value={license} onChange={event => { setLicense(event.currentTarget.value); setLimit(24); }}><option value="all">{copy.all}</option>
        <option value="CC0-1.0">CC0 1.0</option><option value="CC-BY-4.0">CC BY 4.0</option></select></label></>}
    </div>
    {issue && <Notice error><span>{copy.errors[issue]} [SW-{issue}]</span><button className="text-button" onClick={() => setIssue(undefined)}>{copy.close}</button></Notice>}
    {(error || player.failed) && <Notice error><span>{copy.catalogError}</span><button className="text-button" onClick={retry}>{copy.retry}</button></Notice>}
    {section === 'catalog' ? <>
      {!sounds && !error && <p role="status">{copy.loadSounds}</p>}
      {filtered && <p className="result-count" role="status">{filtered.length} {filtered.length === 1 ? copy.oneSound : copy.results}</p>}
      {filtered?.length === 0 && <div className="empty"><Search size={30} /><h2>{copy.noSounds}</h2>
        {favoritesOnly && <p>{copy.noFavorites}</p>}
        <button className="button button-outline" onClick={() => { setQuery(''); setCategory('all'); setLicense('all'); setLengthFilter('all'); setLimit(24); }}>{copy.clearFilters}</button></div>}
      <div className="sound-grid">{visibleCatalog?.map(sound => <SoundCard key={sound.id} sound={sound} playing={player.playing === sound.id}
        play={() => player.play(sound)} use={select ? () => select(sound) : undefined}
        favorite={favorites.includes(sound.id)} onFavorite={() => toggle(sound.id)} onTag={tag => { setQuery(tag); setSpotlight(''); setLimit(24); }} />)}</div>
      {filtered && filtered.length > limit && <button className="button button-outline library-more" onClick={() => setLimit(value => value + 24)}>{copy.moreSounds}</button>}
    </> : !user ? <div className="empty">
      <AudioLines size={30} /><h2>{copy.personalLibrary}</h2><p>{copy.personalAuthHint}</p>
      <button type="button" className="button button-green" onClick={() => navigate('/auth?next=/sounds')}>{copy.createAccount}</button>
    </div> : <>
      <p className="result-count">{copy.personalHint}</p>
      <input ref={input} hidden type="file" accept="audio/*,.wav,.m4a,.mp3,.ogg,.aac,.opus" onChange={event => {
        void addFile(event.currentTarget.files?.[0]); event.currentTarget.value = '';
      }} />
      <button className="button button-green" disabled={busy} onClick={() => input.current?.click()}><Upload size={17} />{copy.personalImport}</button>
      {!visiblePersonal.length && <p className="result-count">{copy.noPersonal}</p>}
      <div className="sound-grid personal-sounds">{visiblePersonal.map(asset => <article className="sound-card" key={asset.id}>
        <div className="sound-head"><div className="sound-icon sound-interface"><AudioLines size={20} /></div>
          <div className="sound-name"><h3>{asset.name}</h3><p>{(asset.duration / 1000).toLocaleString(locale === 'pt' ? 'pt-BR' : 'en-US')} s</p></div>
          <button className="sound-play" aria-label={`${player.playing === asset.id ? copy.stop : copy.play} ${asset.name}`} aria-pressed={player.playing === asset.id} onClick={() => player.play(asset)}>
            {player.playing === asset.id ? <Square size={14} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
        </div>
        <div className="sound-foot"><button className="icon-button" aria-label={`${copy.personalRemove} ${asset.name}`} onClick={() => setPending(asset)}><Trash2 size={16} /></button>
          {select ? <button className="button button-small" onClick={() => select(asset)}><Plus size={16} />{copy.use}</button> :
            <Link className="button button-small" href={`/studio?personal=${asset.id}`}><Plus size={16} />{copy.use}</Link>}
        </div>
      </article>)}</div>
    </>}
    {!select && <section className="meme-sources" aria-label={copy.externalMemeTitle}>
      <div className="meme-source-head">
        <h2>{copy.externalMemeTitle}</h2>
        <p>{copy.externalMemeBody}</p>
      </div>
      <div className="meme-source-grid">
        {externalMemeLibraries.map(site => <a key={site.name} className="meme-source-card" href={site.url} target="_blank" rel="noopener noreferrer">
          <div className="meme-source-top">
            <strong>{site.name}</strong>
            <span className={`meme-source-badge ${site.kind}`}>{site.kind === 'viral' ? copy.externalMemeBadgeViral : copy.externalMemeBadgeFree}</span>
          </div>
          <p>{site[locale]}</p>
          <span className="meme-source-link">{copy.externalMemeOpen} <ExternalLink size={14} /></span>
        </a>)}
      </div>
    </section>}
    {pending && <Modal title={copy.personalRemove} close={() => setPending(undefined)}>
      <p>{pending.name}</p><div className="button-row"><button className="button button-outline" onClick={() => setPending(undefined)}>{copy.cancel}</button>
        <button className="button button-danger" onClick={() => {
          const id = pending.id;
          void removeSound(id).then(() => { if (player.playing === id) player.play(pending); }).catch(() => setIssue('4001'));
          setPending(undefined);
        }}>{copy.remove}</button></div>
    </Modal>}
  </section>;
}
