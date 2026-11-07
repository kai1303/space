import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Attachment } from '../rich-text/rich-text.js';
import { AttachmentDrafts } from './attachment-drafts.js';

const image: Attachment = { id: 'image', name: 'photo.png', size: 12, type: 'image/png', file: new File(['image'], 'photo.png', { type: 'image/png' }), status: 'ready' };
const text: Attachment = { id: 'text', name: 'notes.txt', size: 8, type: 'text/plain', status: 'ready' };
function Draft({ disabled = false }: { disabled?: boolean }) {
  const [files, setFiles] = useState([image, text]);
  return <AttachmentDrafts files={files} onChange={setFiles} disabled={disabled} />;
}
beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'elementFromPoint'); });
it('shows local image thumbnails and releases their object URLs on removal', () => {
  render(<Draft />);
  expect(screen.getByRole('img', { name: 'photo.png' }).getAttribute('src')).toBe('blob:photo');
  fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }));
  expect(screen.queryByRole('img')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
});
it('reorders with accessible move buttons and pointer dragging without losing file metadata', () => {
  render(<Draft />);
  fireEvent.click(screen.getByRole('button', { name: 'Move photo.png later' }));
  expect(screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(['notes.txt', 'photo.png']);
  const handle = screen.getByRole('button', { name: 'Drag photo.png to reorder' });
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => screen.getByRole('listitem', { name: 'notes.txt' }) });
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 10 });
  fireEvent.pointerUp(handle, { clientX: 60, clientY: 10 });
  expect(screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(['photo.png', 'notes.txt']);
  expect(screen.getByRole('img').getAttribute('src')).toBe('blob:photo');
});
it('edits image descriptions, previews the image, and cancels without changing the draft', () => {
  render(<Draft />);
  fireEvent.click(screen.getByRole('button', { name: 'Add description for photo.png' }));
  const dialog = screen.getByRole('dialog', { name: 'photo.png' });
  expect(within(dialog).getByRole('img')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Image description' }), { target: { value: 'A blue square' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save description' }));
  expect(screen.getByRole('img', { name: 'A blue square' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Edit description for photo.png' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Image description' }), { target: { value: 'Discard this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('img', { name: 'A blue square' })).toBeTruthy();
});
it('keeps all draft mutations disabled while sending', () => {
  render(<Draft disabled />);
  for (const name of ['Remove photo.png', 'Move photo.png later', 'Add description for photo.png', 'Drag photo.png to reorder']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});
it('keeps an open description editor and thumbnail when upload assigns the server ID', () => {
  const change = vi.fn();
  const view = render(<AttachmentDrafts files={[{ ...image, status: 'uploading' }]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add description for photo.png' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Image description' }), { target: { value: 'Still editing' } });
  view.rerender(<AttachmentDrafts files={[{ ...image, id: 'server', draftId: image.id }]} onChange={change} />);
  expect((screen.getByRole('textbox', { name: 'Image description' }) as HTMLTextAreaElement).value).toBe('Still editing');
  fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
  expect(change.mock.calls[0]![0][0]).toMatchObject({ id: 'server', description: 'Still editing' });
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
});
it('does not reorder after a cancelled drag or a drop outside the list', () => {
  render(<Draft />);
  vi.stubGlobal('PointerEvent', MouseEvent);
  const handle = screen.getByRole('button', { name: 'Drag photo.png to reorder' });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => screen.getByRole('listitem', { name: 'notes.txt' }) });
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 10 });
  fireEvent.pointerCancel(handle);
  fireEvent.pointerUp(handle);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.body });
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { clientX: 60, clientY: 10 });
  fireEvent.pointerUp(handle);
  expect(screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(['photo.png', 'notes.txt']);
});
it('keeps failed uploads removable and retryable when a thumbnail cannot render', () => {
  const retry = vi.fn(), change = vi.fn();
  render(<AttachmentDrafts files={[{ ...image, status: 'error', error: 'Connection lost' }]} onChange={change} onRetry={retry} />);
  fireEvent.error(screen.getByRole('img'));
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('Connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Retry upload photo.png' }));
  expect(retry).toHaveBeenCalledWith('image');
});
