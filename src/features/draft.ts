import { useEffect, useRef, useState } from 'react';
import { type Project, type StoredAsset } from '../core/project';
import { logError } from '../infrastructure/logger';
import { save } from '../infrastructure/storage';
import { errorCode, type ErrorCode } from '../locales';

export function useDraft(initial: Project, initialAssets: ReadonlyMap<string, StoredAsset>, existing: boolean, onSaved: (project: Project) => void) {
  const [project, setProject] = useState(initial);
  const [assets, setAssets] = useState(initialAssets);
  const [status, setStatus] = useState<'dirty' | 'saving' | 'saved' | 'saveError'>(existing ? 'saved' : 'dirty');
  const [failure, setFailure] = useState<ErrorCode>();
  const [history, setHistory] = useState({ undo: 0, redo: 0 });
  const state = useRef({ project, assets, baseline: existing ? initial.revision : null as number | null, current: 0, persisted: 0 });
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const onSave = useRef(onSaved);
  onSave.current = onSaved;
  const series = useRef({ group: '', at: 0 });
  const syncHistory = () => setHistory({ undo: past.current.length, redo: future.current.length });

  const drain = () => {
    clearTimeout(timer.current);
    if (inFlight.current) return inFlight.current;
    const persist = async () => {
      while (state.current.persisted !== state.current.current) {
        const { project, assets, current, baseline } = state.current;
        if (mounted.current) setStatus('saving');
        try {
          const next = await save(project, assets, baseline);
          state.current.baseline = next.revision;
          state.current.persisted = current;
          if (mounted.current) {
            onSave.current(next);
            setFailure(undefined);
            if (state.current.current === current) setStatus('saved');
          }
        } catch (error) {
          const code = errorCode(error, '4001');
          logError('studio.draft', 'autosave_failed', {
            code,
            detail: error,
            meta: { id: project.id.slice(0, 8), baseline, assets: assets.size },
          });
          if (mounted.current) {
            setFailure(code);
            setStatus('saveError');
          }
          return;
        }
      }
    };
    inFlight.current = persist().finally(() => { inFlight.current = null; });
    return inFlight.current;
  };
  const flush = useRef(drain);
  flush.current = drain;
  useEffect(() => {
    mounted.current = true;
    const visibility = () => { if (document.hidden) void flush.current(); };
    const pagehide = () => { void flush.current(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      if (state.current.current !== state.current.persisted) void flush.current();
    };
  }, []);

  function apply(next: Project, additions: StoredAsset[] = [], critical = false) {
    const current = state.current;
    current.project = next;
    if (additions.length) {
      current.assets = new Map([...current.assets, ...additions.map(asset => [asset.id, asset] as const)]);
      setAssets(current.assets);
    }
    current.current++;
    setProject(next);
    setStatus('saving');
    clearTimeout(timer.current);
    if (critical) void drain();
    else timer.current = setTimeout(() => void drain(), 500);
  }
  function change(update: (previous: Project) => Project, settings: { additions?: StoredAsset[]; group?: string; critical?: boolean } = {}) {
    const previous = state.current.project;
    const next = update(previous);
    if (next === previous) return;
    const now = Date.now();
    const group = settings.group ?? '';
    if (!group || series.current.group !== group || now - series.current.at > 450) {
      past.current = [...past.current.slice(-19), previous];
    }
    series.current = { group, at: now };
    future.current = [];
    syncHistory();
    apply(next, settings.additions, settings.critical);
  }
  function undo(redo = false) {
    const from = redo ? future.current : past.current;
    const to = redo ? past.current : future.current;
    const next = from.pop();
    if (!next) return;
    to.push(state.current.project);
    series.current = { group: '', at: 0 };
    syncHistory();
    apply(next);
  }
  async function copyDraft() {
    await drain();
    const original = state.current.project;
    return save({ ...original, id: crypto.randomUUID(), revision: 0 }, state.current.assets, null);
  }
  return { project, assets, status, failure, history, change, undo, drain, copyDraft, state };
}
