import { useState, type FormEvent } from 'react';
import { Lock, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useApp } from '../app/context';
import { Notice } from '../app/shared';
import { errorCode, type ErrorCode } from '../locales';

export function AuthScreen({ nextPath = '/studio', initialMode = 'register' }: { nextPath?: string; initialMode?: 'register' | 'login' }) {
  const { copy, register, login, navigate } = useApp();
  const [mode, setMode] = useState<'register' | 'login'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ErrorCode>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setNotice(undefined);
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();
    if (!trimmedEmail || password.length < (mode === 'register' ? 6 : 1) || (mode === 'register' && trimmedName.length < 2)) {
      setNotice('7002');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') await register({ name: trimmedName, email: trimmedEmail, password });
      else await login({ email: trimmedEmail, password });
      navigate(nextPath, true);
    } catch (error) {
      setNotice(errorCode(error, '7004'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="wrap page auth-page">
    <div className="auth-card">
      <p className="eyebrow"><Lock size={17} />{copy.account}</p>
      <h1>{mode === 'register' ? copy.createAccount : copy.signIn}</h1>
      <p className="page-intro">{mode === 'register' ? copy.authCreateSubtitle : copy.authLoginSubtitle}</p>

      <div className="segmented auth-mode-tabs" role="group" aria-label={copy.account}>
        <button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setNotice(undefined); }}>
          <UserPlus size={15} />{copy.createAccount}
        </button>
        <button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setNotice(undefined); }}>
          <LogIn size={15} />{copy.signIn}
        </button>
      </div>

      {notice && <Notice error><span>{copy.errors[notice]} [SW-{notice}]</span></Notice>}

      <form className="auth-form" onSubmit={event => void submit(event)} noValidate>
        {mode === 'register' && <label className="auth-field">
          <span>{copy.nameLabel}</span>
          <input type="text" autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={event => setName(event.currentTarget.value)} />
        </label>}
        <label className="auth-field">
          <span>{copy.emailLabel}</span>
          <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.currentTarget.value)} />
        </label>
        <label className="auth-field">
          <span>{copy.passwordLabel}</span>
          <input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={6} maxLength={128}
            value={password} onChange={event => setPassword(event.currentTarget.value)} />
          {mode === 'register' && <small>{copy.passwordHint}</small>}
        </label>
        <button type="submit" className="button button-green full" disabled={busy}>
          {mode === 'register' ? <UserPlus size={17} /> : <LogIn size={17} />}
          {mode === 'register' ? copy.createAccount : copy.loginButton}
        </button>
      </form>

      <p className="auth-note"><ShieldCheck size={16} /><span>{copy.authZeroCostNote}</span></p>
      <button type="button" className="text-button auth-switch" onClick={() => { setMode(m => m === 'register' ? 'login' : 'register'); setNotice(undefined); }}>
        {mode === 'register' ? copy.haveAccount : copy.needAccount}
      </button>
    </div>
  </section>;
}
