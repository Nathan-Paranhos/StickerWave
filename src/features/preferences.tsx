import { Moon, Sun } from 'lucide-react';
import { useApp } from '../app/context';

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