import { createContext, useContext, type AnchorHTMLAttributes } from 'react';
import type { Copy, Locale } from '../locales';
import type { AuthUser } from '../infrastructure/api';

export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

type AppContext = {
  copy: Copy; locale: Locale; theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (theme: Theme) => void;
  toggleLanguage: () => void; path: string; navigate: (to: string, replace?: boolean, soft?: boolean) => void;
  user: AuthUser | null; authReady: boolean;
  register: (input: { name: string; email: string; password: string }) => Promise<AuthUser>;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  logout: () => Promise<void>;
};
export const Context = createContext<AppContext | null>(null);
export function useApp() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing app context');
  return context;
}
export function Link({ href = '/', onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useApp();
  return <a href={href} {...props} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !href.startsWith('/')) return;
    event.preventDefault();
    navigate(href);
  }} />;
}
