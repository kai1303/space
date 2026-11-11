import { StrictMode, type ReactNode } from 'react';
import { Toaster } from '@space/ui/primitives';
import { MotionConfig } from 'motion/react';
import { motionTransition } from '@space/ui/motion';

export function AppProviders({ children }: { children: ReactNode }) {
  return <StrictMode><MotionConfig reducedMotion="user" transition={motionTransition(false)}>{children}<Toaster position="bottom-center" /></MotionConfig></StrictMode>;
}
