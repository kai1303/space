import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { Dialog } from './primitives.js';

const animations = vi.hoisted(() => [] as { finish: () => void; stop: ReturnType<typeof vi.fn> }[]);
vi.mock('motion/react', async importOriginal => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => false, useAnimate: () => [useRef(null), animate] };
});
const animate = vi.fn((_element: Element, _values: Record<string, unknown>, _options: { duration: number }) => {
  let finish!: () => void;
  const result = new Promise<void>(resolve => { finish = resolve; });
  const stop = vi.fn();
  animations.push({ finish, stop });
  return Object.assign(result, { stop });
});
beforeEach(() => {
  animations.length = 0;
  animate.mockClear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps a dismissed modal open until its exit finishes and notifies once', async () => {
  const onClose = vi.fn();
  render(<Dialog open title="Example" onClose={onClose}>Content</Dialog>);
  const dialog = screen.getByRole('dialog') as HTMLDialogElement;
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { animations.at(-1)!.finish(); });
  expect(dialog.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it('animates a controlled close and cancels it if reopened', async () => {
  const onClose = vi.fn();
  const { rerender } = render(<Dialog open title="Example" onClose={onClose}>Content</Dialog>);
  const dialog = screen.getByRole('dialog') as HTMLDialogElement;
  rerender(<Dialog open={false} title="Example" onClose={onClose}>Content</Dialog>);
  expect(dialog.open).toBe(true);
  const exit = animations.at(-1)!;
  rerender(<Dialog open title="Example" onClose={onClose}>Content</Dialog>);
  await act(async () => { exit.finish(); });
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it('preserves the unsaved-edit guard on Escape', () => {
  const onClose = vi.fn();
  render(<Dialog open title="Example" onClose={onClose} onBeforeClose={() => false}>Draft</Dialog>);
  const before = animations.length;
  const event = new Event('cancel', { cancelable: true });
  fireEvent(screen.getByRole('dialog'), event);
  expect(event.defaultPrevented).toBe(true);
  expect(animations).toHaveLength(before);
  expect(onClose).not.toHaveBeenCalled();
});

it('animates a mobile sidebar in both directions and restores desktop visibility', async () => {
  const { useSidebarMotion } = await import('../motion/motion.js');
  let change!: () => void;
  const media = { matches: true, addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  function Sidebar({ open }: { open: boolean }) {
    const ref = useSidebarMotion<HTMLElement>(open, '(max-width: 760px)');
    return <aside ref={ref}>Conversations</aside>;
  }
  const { rerender } = render(<Sidebar open={false} />);
  const node = screen.getByText('Conversations');
  await act(async () => { animations.at(-1)!.finish(); });
  expect(node.style.visibility).toBe('hidden');
  expect(node.inert).toBe(true);
  rerender(<Sidebar open />);
  expect(node.inert).toBe(false);
  expect(animate.mock.calls.at(-1)?.[2]?.duration).toBe(0.18);
  rerender(<Sidebar open={false} />);
  expect(node.style.visibility).toBe('visible');
  expect(node.inert).toBe(true);
  await act(async () => { animations.at(-1)!.finish(); });
  expect(node.style.visibility).toBe('hidden');
  await act(async () => { media.matches = false; change(); animations.at(-1)!.finish(); });
  expect(node.inert).toBe(false);
  expect(node.style.visibility).toBe('visible');
  vi.unstubAllGlobals();
});

it('initializes a sidebar that mounts after workspace loading and animates its first toggle', async () => {
  const { useSidebarMotion } = await import('../motion/motion.js');
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  function Shell({ workspace, open }: { workspace: string; open: boolean }) {
    const ref = useSidebarMotion<HTMLDivElement>(open, '(max-width: 720px)', '.drawer', workspace);
    return <div ref={ref}>{workspace && <aside key={workspace} className="drawer">Conversations</aside>}</div>;
  }
  const { rerender } = render(<Shell workspace="" open={false} />);
  expect(animate).not.toHaveBeenCalled();
  rerender(<Shell workspace="one" open={false} />);
  expect(animate.mock.calls.at(-1)?.[2].duration).toBe(0);
  rerender(<Shell workspace="one" open />);
  expect(animate.mock.calls.at(-1)?.[2].duration).toBe(0.18);
  rerender(<Shell workspace="two" open={false} />);
  expect(animate.mock.calls.at(-1)?.[2].duration).toBe(0);
});
