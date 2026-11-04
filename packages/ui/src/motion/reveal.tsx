import type { ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { motionTransition } from './motion.js';

export function Reveal({ open, immediateExit = false, clip = true, id, children }: {
  open: boolean;
  immediateExit?: boolean;
  clip?: boolean;
  id?: string;
  children: ReactNode;
}) {
  const content = open && <RevealContent key="content" id={id} clip={clip}>{children}</RevealContent>;
  // Codes and keys must leave the DOM as soon as they are hidden.
  return immediateExit ? content : <AnimatePresence initial={false}>{content}</AnimatePresence>;
}

function RevealContent({ id, clip, children }: { id?: string; clip: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  return <motion.div id={id} inert={!present} aria-hidden={!present || undefined}
    initial={reduced ? false : { height: 0, opacity: 0 }}
    animate={{ height: 'auto', opacity: 1 }}
    exit={{ height: 0, opacity: 0 }}
    transition={motionTransition(reduced)} style={{ overflow: clip || !present ? 'hidden' : 'visible' }}>
    {children}
  </motion.div>;
}
