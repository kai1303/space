import { useSyncExternalStore } from 'react';

const preference = '(prefers-reduced-motion: reduce)';
function subscribe(onChange: () => void) {
  const media = window.matchMedia(preference);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
const snapshot = () => window.matchMedia(preference).matches;

export function useLaunchMotion() {
  // Subscribe directly so changing the OS preference also updates mounted interactions.
  const reduced = useSyncExternalStore(subscribe, snapshot, () => false);
  const transition = { duration: reduced ? 0 : .24, ease: [0.22, 1, 0.36, 1] as const };
  return {
    reduced,
    transition,
    reveal: { initial: { opacity: reduced ? 1 : 0 }, animate: { opacity: 1 }, transition },
    feedback: { whileHover: { y: reduced ? 0 : -2 }, whileTap: { scale: reduced ? 1 : .97 }, transition },
  };
}
