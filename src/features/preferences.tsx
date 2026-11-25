import { useEffect, useState } from 'react';
import { Download, Moon, Sun } from 'lucide-react';
import { useApp } from '../app/context';

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let installPrompt: PromptEvent | undefined;
function notifyInstall() { window.dispatchEvent(new Event('stickerwave:install')); }
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event as PromptEvent;
  notifyInstall();
});
window.addEventListener('appinstalled', () => { installPrompt = undefined; notifyInstall(); });

export function ThemeControl() {
  const { copy, resolvedTheme, setTheme } = useApp();
  return <div className="theme-control" role="group" aria-label={copy.theme}>
    <button
      type="button"
      className="theme-button"
      aria-label={copy.light}
      title={copy.light}
      aria-pressed={resolvedTheme === 'light'}
      onClick={() => setTheme('light')}
    >
      <Sun size={16} />
    </button>
    <button
      type="button"
      className="theme-button"
      aria-label={copy.dark}
      title={copy.dark}
      aria-pressed={resolvedTheme === 'dark'}
      onClick={() => setTheme('dark')}
    >
      <Moon size={16} />
    </button>
  </div>;
}
export function InstallControl() {
  const { copy } = useApp();
  const [ready, setReady] = useState(Boolean(installPrompt));
  useEffect(() => {
    const update = () => setReady(Boolean(installPrompt));
    window.addEventListener('stickerwave:install', update);
    return () => window.removeEventListener('stickerwave:install', update);
  }, []);
  if (!ready) return null;
  return <button className="button button-outline button-small" onClick={() => {
    const request = installPrompt;
    installPrompt = undefined;
    notifyInstall();
    void request?.prompt().catch(() => undefined);
  }}><Download size={17} />{copy.install}</button>;
}
