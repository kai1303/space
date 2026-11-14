import type { ComponentProps } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'motion/react';
import { surfaceMotion } from './motion.js';

type Props = ComponentProps<typeof motion.div> & { fadeOnly?: boolean };

export function PopoverSurface({ fadeOnly, ...props }: Props) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  // Fixed-position children need an untransformed parent.
  const animation = surfaceMotion(reduced, fadeOnly ? 'scrim' : 'popover');
  return <motion.div {...props} {...animation} inert={!present} aria-hidden={!present || undefined}/>;
}
