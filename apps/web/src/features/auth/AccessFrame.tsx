import { Spinner } from '@space/ui/primitives';
import { useEffect, useRef, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '@space/ui/motion';
import { SpaceLogo } from '../../shared/branding/SpaceLogo.js';
import './access.css';

export function AccessFrame({ screen, title, description, step, children, loading = false }: {
  screen: string; title: string; description?: string; step?: 1 | 2; children: ReactNode; loading?: boolean;
}) {
  const reduced = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (!loading) heading.current?.focus({ preventScroll: true }); }, [screen, loading]);
  return <main className="chat-login access-page">
    <div className="access-frame">
      <div className="access-brand"><SpaceLogo /></div>
      <div className="access-progress">
        {step && <ol aria-label="Account setup">
          <li aria-current={step === 1 ? 'step' : undefined} data-complete={step === 2}>Account</li>
          <li aria-current={step === 2 ? 'step' : undefined}>Workspace</li>
        </ol>}
      </div>
      <motion.section key={screen} className="access-content" initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={motionTransition(reduced, .22)}>
        <header className="access-heading">
          <h1 ref={heading} tabIndex={-1}>{title}</h1>
          {description && <p>{description}</p>}
        </header>
        {children}
      </motion.section>
    </div>
  </main>;
}

export function AccessLoading({ message = 'Opening your workspace…' }: { message?: string }) {
  return <AccessFrame screen="loading" title="Getting things ready." loading>
    <p className="access-status" role="status"><Spinner />{message}</p>
  </AccessFrame>;
}
