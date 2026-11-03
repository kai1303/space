import { useEffect, useRef } from 'react';
import { useAnimate, useReducedMotion } from 'motion/react';

export function motionTransition(reduced: boolean | null, duration = 0.18) {
  return { duration: reduced ? 0 : duration, ease: [0.2, 0, 0, 1] as const };
}

export function surfaceMotion(reduced: boolean | null, kind: 'popover' | 'modal' | 'right' | 'scrim' = 'popover') {
  const hidden = {
    opacity: 0,
    ...(kind === 'right' ? { x: reduced ? 0 : 24 } : {}),
    ...(kind === 'popover' || kind === 'modal' ? { y: reduced ? 0 : 6, scale: reduced ? 1 : 0.98 } : {}),
  };
  return {
    initial: hidden,
    animate: { opacity: 1, x: 0, y: 0, scale: 1 },
    exit: hidden,
    transition: motionTransition(reduced),
  };
}

// Keep desktop navigation mounted; only the mobile drawer moves off screen.
export function useSidebarMotion<T extends HTMLElement>(open: boolean, query: string, selector?: string, contentKey?: string) {
  const [scope, animate] = useAnimate<T>();
  const reduced = useReducedMotion();
  const previousNode = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = selector ? scope.current?.querySelector<HTMLElement>(selector) : scope.current;
    if (!node || typeof matchMedia !== 'function') return;
    const media = matchMedia(query);
    let animation: ReturnType<typeof animate> | undefined;
    let version = 0;
    const update = (initial = false) => {
      const current = ++version;
      animation?.stop();
      const hidden = media.matches && !open;
      node.inert = hidden;
      node.style.visibility = 'visible';
      animation = animate(node, { x: hidden && !reduced ? 'calc(-100% - 52px)' : 0, opacity: hidden ? 0 : 1 }, motionTransition(reduced, initial || !media.matches ? 0 : 0.18));
      void animation.then(() => { if (current === version) node.style.visibility = hidden ? 'hidden' : 'visible'; });
    };
    update(previousNode.current !== node);
    previousNode.current = node;
    const change = () => update();
    media.addEventListener('change', change);
    return () => { version++; animation?.stop(); media.removeEventListener('change', change); };
  }, [open, query, selector, contentKey, reduced, animate, scope]);
  return scope;
}
