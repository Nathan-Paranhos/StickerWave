import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '../ui.css';
import { en, pt, type Locale } from '../locales';
import { Context, type ResolvedTheme, type Theme } from './context';
import { AuthScreen } from '../features/auth';
import { Editorial, Footer, Header, Landing, ProjectsPage, type EditorialPage } from '../features/pages';
import { SoundLibrary } from '../features/sounds';
import { fetchCurrentUser, loginAccount, logoutAccount, registerAccount, type AuthUser } from '../infrastructure/api';
import { setStorageUser } from '../infrastructure/storage';

const Studio = lazy(() => import('../features/studio'));
const WhatsAppAdminPage = lazy(() => import('../features/whatsapp-admin').then(m => ({ default: m.WhatsAppAdminPage })));
function readLocale(): Locale {
  try { return localStorage.getItem('stickerwave:language') === 'en' ? 'en' : 'pt'; }
  catch { return 'pt'; }
}
function App() {
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const [locale, setLocale] = useState<Locale>(readLocale);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('stickerwave:theme');
      return saved === 'dark' || saved === 'light' ? saved : 'system';
    } catch { return 'system'; }
  });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    if (theme !== 'system') return theme;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const active: ResolvedTheme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = active;
      setResolvedTheme(active);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', active === 'dark' ? '#171b17' : '#f7f8f4');
    };
    apply();
    try { localStorage.setItem('stickerwave:theme', theme); } catch { /* theme is session-only */ }
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    let active = true;
    void fetchCurrentUser().then(current => {
      if (!active) return;
      setStorageUser(current?.id ?? null);
      setUser(current);
      setAuthReady(true);
    });
    return () => { active = false; };
  }, []);
  const copy = locale === 'en' ? en : pt;
  const path = url.split('?')[0].replace(/\/$/, '') || '/';
  const studioRequested = path === '/studio' || path.startsWith('/studio/');
  const studio = studioRequested && Boolean(user);
  const protectedRoute = studioRequested || path === '/projects' || path === '/favorites';
  useEffect(() => {
    const update = () => setUrl(location.pathname + location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === 'pt' ? 'pt-BR' : 'en-US';
    document.title = path === '/' ? `StickerWave · ${copy.heroTitle} ${copy.heroSecond}` : `StickerWave · ${studio ? copy.studio : path === '/auth' ? copy.account : copy[path.slice(1) as EditorialPage] ?? copy.studio}`;
  }, [locale, copy, path, studio]);
  const register = async (input: { name: string; email: string; password: string; confirmPassword?: string }) => {
    const created = await registerAccount(input);
    setStorageUser(created.id);
    setUser(created);
    return created;
  };
  const login = async (input: { email: string; password: string }) => {
    const logged = await loginAccount(input);
    setStorageUser(logged.id);
    setUser(logged);
    return logged;
  };
  const logout = async () => {
    await logoutAccount();
    setStorageUser(null);
    setUser(null);
    if (protectedRoute || path === '/auth') navigate('/', true);
  };
  const toggleLanguage = () => {
    const next = locale === 'pt' ? 'en' : 'pt';
    try { localStorage.setItem('stickerwave:language', next); } catch { /* available for this tab */ }
    setLocale(next);
  };
  const navigate = (to: string, replace = false, soft = false) => {
    if (to !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState']({}, '', to);
    if (!soft) {
      setUrl(to);
      window.scrollTo(0, 0);
      requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
    }
  };
  const editorial = ['docs', 'privacy', 'licenses', 'about', 'contribute'];
  const topic = path.slice(1) as EditorialPage;
  const authNext = (() => {
    if (path !== '/auth') return url;
    const target = new URLSearchParams(url.split('?')[1] ?? '').get('next');
    return target && target.startsWith('/') && !target.startsWith('//') ? target : '/studio';
  })();
  return <Context.Provider value={{ locale, copy, theme, resolvedTheme, setTheme, toggleLanguage, path, navigate, user, authReady, register, login, logout }}>
    <a className="skip-link" href="#main">{copy.skip}</a>
    {!studio && <Header />}
    <main id="main" tabIndex={-1} className={studio ? 'studio-main' : ''}>
      {protectedRoute && !authReady ? <p className="wrap page" role="status">{copy.checkingAccount}</p>
        : (protectedRoute && !user) || (path === '/auth' && !user) ? <AuthScreen nextPath={authNext} />
        : path === '/auth' && user ? <section className="wrap page auth-page"><div className="auth-card">
            <p className="eyebrow">{copy.account}</p><h1>{user.name}</h1><p className="page-intro">{user.email}</p>
            <div className="button-row"><button className="button button-green" onClick={() => navigate('/studio')}>{copy.studio}</button>
              <button className="button button-outline" onClick={() => void logout()}>{copy.signOut}</button></div>
          </div></section>
        : studio ? <Suspense fallback={<p className="wrap page" role="status">{copy.starting}</p>}><Studio key={url} id={path.split('/')[2]} query={url.split('?')[1] ?? ''} /></Suspense>
        : path === '/whatsapp' ? <Suspense fallback={<p className="wrap page" role="status">{copy.starting}</p>}><WhatsAppAdminPage /></Suspense>
        : path === '/' ? <Landing />
        : path === '/sounds' ? <SoundLibrary key="sounds" />
        : path === '/favorites' ? <SoundLibrary key="favorites" favoritesOnly />
        : path === '/projects' ? <ProjectsPage />
        : editorial.includes(topic) ? <Editorial topic={topic} /> : <Editorial topic="docs" />}
    </main>
    {!studio && <Footer />}
  </Context.Provider>;
}
createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined), { once: true });
}
