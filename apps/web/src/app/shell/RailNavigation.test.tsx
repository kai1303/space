import { act, waitFor, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RailNavigation, type RailPreview } from './RailNavigation.js';

afterEach(cleanup);
const renderPreview = (view: RailPreview, close: () => void) => <button onClick={close}>Open {view} row</button>;
const props = { onHome: vi.fn(), onDirectMessages: vi.fn(), onActivity: vi.fn(), onNavigate: vi.fn(), renderPreview };

it('opens one delayed preview, allows entry and interaction, and preserves the current page', async () => {
  render(<RailNavigation {...props} active="home"/>);
  const dm = screen.getByRole('button', {name:'DMs'});
  fireEvent.pointerEnter(dm, {pointerType:'mouse'});
  expect(screen.queryByRole('dialog')).toBeNull();
  const panel = await screen.findByRole('dialog', {name:'DMs'});
  expect(screen.getByRole('link', {name:'Home'}).getAttribute('aria-current')).toBe('page');
  expect(props.onDirectMessages).not.toHaveBeenCalled();
  fireEvent.pointerLeave(dm);
  fireEvent.pointerEnter(panel);
  fireEvent.click(within(panel).getByText('Open dms row'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('exposes the preview by keyboard, restores focus on Escape, and skips the active page', async () => {
  const view = render(<RailNavigation {...props} active="dms"/>);
  const dm = screen.getByRole('button', {name:'DMs'});
  expect(dm.hasAttribute('aria-haspopup')).toBe(false);
  expect(screen.getByRole('button', {name:'Agents & tools'}).hasAttribute('aria-haspopup')).toBe(false);
  const files = screen.getByRole('button', {name:'Files'});
  fireEvent.keyDown(files,{key:'ArrowRight'});
  const item = within(await screen.findByRole('dialog',{name:'Files'})).getByRole('button');
  expect(document.activeElement).toBe(item);
  fireEvent.keyDown(item,{key:'Escape'});
  expect(document.activeElement).toBe(files);
  fireEvent.pointerEnter(screen.getByRole('button',{name:'To-dos'}));
  view.unmount();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('cancels a passing hover and keeps clicks on destinations immediate', async () => {
  render(<RailNavigation {...props} active="home"/>);
  const dms=screen.getByRole('button',{name:'DMs'}), files=screen.getByRole('button',{name:'Files'});
  fireEvent.pointerEnter(dms); fireEvent.pointerLeave(dms); fireEvent.pointerEnter(files);
  await screen.findByRole('dialog',{name:'Files'});
  expect(screen.queryByRole('dialog',{name:'DMs'})).toBeNull();
  fireEvent.click(files);
  expect(props.onNavigate).toHaveBeenCalledWith('files');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('dismisses a hovered panel after using a filter and cancels a pending hover on Escape', async () => {
  render(<RailNavigation {...props} active="home" renderPreview={() => <button>Unreads</button>}/>);
  const activity = screen.getByRole('button', {name:'Activity'});
  fireEvent.pointerEnter(activity);
  const panel = await screen.findByRole('dialog', {name:'Activity'});
  within(panel).getByRole('button').focus();
  fireEvent.pointerLeave(panel);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(activity);
    fireEvent.keyDown(document, {key:'Escape'});
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('keeps a clicked Admin menu open on pointer exit and supports arrow key selection', async () => {
  const manage = vi.fn();
  render(<RailNavigation {...props} active="home" adminItems={[{label:'Settings',onSelect:vi.fn()},{label:'Members',onSelect:manage}]}/>);
  const admin = screen.getByRole('button',{name:'Admin'});
  fireEvent.pointerEnter(admin);
  const menu = await screen.findByRole('menu',{name:'Admin tools'});
  fireEvent.click(admin);
  fireEvent.pointerLeave(admin);
  const first = within(menu).getByRole('menuitem',{name:'Settings'});
  first.focus();
  fireEvent.keyDown(first,{key:'ArrowDown'});
  const members = within(menu).getByRole('menuitem',{name:'Members'});
  expect(document.activeElement).toBe(members);
  fireEvent.click(members);
  expect(manage).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});
