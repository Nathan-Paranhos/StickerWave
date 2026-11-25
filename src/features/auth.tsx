import { useId, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, LogIn, ShieldCheck, UserPlus } from 'lucide-react';
import { useApp } from '../app/context';
import { Notice } from '../app/shared';
import { errorCode, type ErrorCode } from '../locales';

function PasswordField({
  label, value, onChange, autoComplete, hint, mismatch, showLabel, hideLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  mismatch?: string;
  showLabel: string;
  hideLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  const noteId = useId();
  const hasNote = Boolean(mismatch || hint);
  return <div className="auth-field">
    <label htmlFor={inputId}>{label}</label>
    <div className="password-wrap">
      <input
        id={inputId}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        required
        minLength={6}
        maxLength={128}
        aria-describedby={hasNote ? noteId : undefined}
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        className="password-eye"
        aria-label={`${visible ? hideLabel : showLabel}: ${label}`}
        aria-pressed={visible}
        onClick={() => setVisible(current => !current)}
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
    {mismatch ? <small id={noteId} className="field-error" role="status">{mismatch}</small> : hint ? <small id={noteId}>{hint}</small> : null}
  </div>;
}

export function AuthScreen({ nextPath = '/studio', initialMode = 'register' }: { nextPath?: string; initialMode?: 'register' | 'login' }) {
  const { copy, register, login, navigate } = useApp();
  const [mode, setMode] = useState<'register' | 'login'>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ErrorCode>();

  const mismatch = mode === 'register' && confirmPassword.length > 0 && password !== confirmPassword ? copy.passwordMismatchHint : undefined;

  function switchMode(next: 'register' | 'login') {
    setMode(next);
    setConfirmPassword('');
    setNotice(undefined);
  }

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
    if (mode === 'register' && password !== confirmPassword) {
      setNotice('7005');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') await register({ name: trimmedName, email: trimmedEmail, password, confirmPassword });
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
        <button type="button" aria-pressed={mode === 'register'} onClick={() => switchMode('register')}>
          <UserPlus size={15} />{copy.createAccount}
        </button>
        <button type="button" aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>
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
        <PasswordField
          label={copy.passwordLabel}
          value={password}
          onChange={setPassword}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          hint={mode === 'register' ? copy.passwordHint : undefined}
          showLabel={copy.showPassword}
          hideLabel={copy.hidePassword}
        />
        {mode === 'register' && <PasswordField
          label={copy.confirmPasswordLabel}
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          mismatch={mismatch}
          showLabel={copy.showPassword}
          hideLabel={copy.hidePassword}
        />}
        <button type="submit" className="button button-green full" disabled={busy}>
          {mode === 'register' ? <UserPlus size={17} /> : <LogIn size={17} />}
          {mode === 'register' ? copy.createAccount : copy.loginButton}
        </button>
      </form>

      <p className="auth-note"><ShieldCheck size={16} /><span>{copy.authZeroCostNote}</span></p>
      <button type="button" className="text-button auth-switch" onClick={() => switchMode(mode === 'register' ? 'login' : 'register')}>
        {mode === 'register' ? copy.haveAccount : copy.needAccount}
      </button>
    </div>
  </section>;
}
