import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { formatDiagnosticLogsText } from '../infrastructure/logger';
import { Link, useApp } from './context';

export function Brand() {
  return <Link href="/" className="brand"><img src="/images/mark.svg" alt="" width="36" height="36" /><span>StickerWave</span></Link>;
}

export function Bars({ bars, className = '' }: { bars: readonly number[]; className?: string }) {
  return <div className={`bars ${className}`} aria-hidden="true">
    {bars.map((value, index) => <i key={index} style={{ height: `${Math.max(8, value * 100)}%` }} />)}
  </div>;
}

export function Modal({ title, children, close, className = '' }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const { copy } = useApp();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className={`modal ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button className="icon-button" aria-label={copy.close} onClick={close}><X size={20} /></button></header>
    {children}
  </dialog>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}

/** Collapsible viewer showing sanitized session diagnostic logs without leaking secrets. */
export function DiagnosticLogsBox({ limit = 25, showWhenEmpty = false }: { limit?: number; showWhenEmpty?: boolean }) {
  const { copy } = useApp();
  const [open, setOpen] = useState(false);
  const text = formatDiagnosticLogsText(limit);
  if (!text && !showWhenEmpty) return null;
  return <details className="diag-logs-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="diag-logs-summary">{copy.diagnosticLogsTitle}</summary>
    {open && <div className="diag-logs-body">
      <p className="diag-logs-hint">{copy.diagnosticLogsHint}</p>
      {text ? <pre className="diag-logs-pre">{text}</pre> : <p className="diag-logs-empty">{copy.diagnosticLogsEmpty}</p>}
    </div>}
  </details>;
}
