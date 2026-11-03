import { expect, it } from 'vitest';
import { motionTransition } from './motion.js';

it('keeps authored timing and easing in the normal motion policy', () => {
  expect(motionTransition(false)).toEqual({duration:0.18,ease:[0.2,0,0,1]});
  expect(motionTransition(false,0.12).duration).toBe(0.12);
});
it.each([0.12,0.18,0.22])('removes animation duration under reduced motion (%s)', duration => {
  expect(motionTransition(true,duration).duration).toBe(0);
});
