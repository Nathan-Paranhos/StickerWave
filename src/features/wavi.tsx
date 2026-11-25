import { lazy, Suspense, useState, type CSSProperties } from 'react';
import { AudioLines, Box } from 'lucide-react';
import { useApp } from '../app/context';
import type { WaviState } from './wavi-model';

const Model = lazy(() => import('./wavi-model'));
const poses: WaviState[] = ['Idle', 'Dance', 'Talk', 'Celebrate'];

export function Wavi({ small, level = 0, bass = 0, state = 'Idle' }: {
  small?: boolean; level?: number; bass?: number; state?: WaviState;
}) {
  const { copy } = useApp();
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pose, setPose] = useState<WaviState | null>(null);
  const display = on && !failed;
  const effectiveState = state !== 'Idle' ? state : (pose ?? 'Idle');
  const toggle = () => setOn(value => !value);
  const energy = Math.min(1, level * 0.8 + bass * 0.6);

  if (small) return <div className="wavi-tool" style={{ '--wavi-energy': energy } as CSSProperties}>
    <button className="button button-small" disabled={failed} aria-pressed={display} onClick={toggle}><Box size={16} />{display ? copy.waviStatic : copy.wavi3d}</button>
    {on && (display
      ? <Suspense fallback={<img src="/models/wavi-avatar.png" alt="" />}><Model small state={effectiveState} level={level} bass={bass} failed={() => setFailed(true)} /></Suspense>
      : <img src="/models/wavi-avatar.png" alt="" />)}
  </div>;

  return <figure className={`hero-art ${energy > 0.05 ? 'wavi-grooving' : ''}`} style={{ '--wavi-energy': energy } as CSSProperties}>
    <img src="/images/wavi.webp" alt="" width="1150" height="767" fetchPriority="high" />
    {display && <Suspense fallback={null}><Model state={effectiveState} level={level} bass={bass} failed={() => setFailed(true)} /></Suspense>}
    <figcaption><span className="wavi-dot" />{display ? copy.waviInteract : copy.wavi}</figcaption>
    <div className="art-wave" aria-hidden="true"><AudioLines size={30} strokeWidth={2} /></div>
    {display && <div className="wavi-poses" role="group" aria-label={copy.waviPoses}>
      {poses.map(item => <button key={item} type="button" className="wavi-pose-chip" aria-pressed={effectiveState === item}
        onClick={() => setPose(item)}>{copy[`waviPose${item}` as keyof typeof copy] as string}</button>)}
    </div>}
    <button className="button button-small wavi-switch" disabled={failed} onClick={toggle} aria-pressed={display}><Box size={16} />{display ? copy.waviStatic : copy.wavi3d}</button>
  </figure>;
}
