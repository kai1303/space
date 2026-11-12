import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetAttachment, AssetPreview } from '@space/contracts';
import * as live from '../../shared/realtime/live-updates.js';
import { AssetAttachments } from './AssetAttachments.js';

const asset = (id: string, name = `${id}.png`): AssetAttachment => ({ id, name, size: 1024, type: 'application/octet-stream' });
function previews(values: Record<string, AssetPreview>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => values[url.split('/')[3]!] })));
}
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses saved image descriptions for the card and full preview', async () => {
  previews({ a: { kind: 'image', mime: 'image/webp', width: 200, height: 100 } });
  render(<AssetAttachments assets={[{ ...asset('a'), description: 'Blue square on white' }]} />);
  expect(await screen.findByRole('img', { name: 'Blue square on white' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Preview a.png' }));
  expect(await within(screen.getByRole('dialog')).findByRole('img', { name: 'Blue square on white' })).toBeTruthy();
});
it('offers an explicit full preview from a compact, bounded text card', async () => {
  previews({ a: { kind: 'text', text: 'A very long line '.repeat(500), language: 'text', truncated: false } });
  render(<AssetAttachments assets={[asset('a', 'notes.txt')]} />);
  const open = await screen.findByRole('button', { name: 'Open preview of notes.txt' });
  expect(screen.getAllByRole('button', { name: /preview.*notes\.txt/i })).toHaveLength(1);
  expect(document.querySelector('.asset-snippet pre')!.textContent!.length).toBeLessThanOrEqual(600);
  await userEvent.click(open);
  expect(await within(screen.getByRole('dialog')).findByRole('region', { name: 'Text file preview' })).toBeTruthy();
});
it('shows server-approved image thumbnails and navigates files in a shared viewer with focus return', async () => {
  previews({ a: { kind: 'image', mime: 'image/webp', width: 1200, height: 600 }, b: { kind: 'image', mime: 'image/gif', width: 500, height: 800 } });
  render(<AssetAttachments assets={[asset('a'), asset('b')]} />);
  expect((await screen.findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('/v1/assets/a/thumbnail');
  expect(screen.getByRole('link', { name: 'Download a.png' }).getAttribute('href')).toBe('/v1/assets/a/download');
  const opener = screen.getByRole('button', { name: 'Preview a.png' });
  await userEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'a.png' });
  expect((await within(dialog).findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('/v1/assets/a/original-image');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
  expect(within(dialog).getByRole('slider', { name: 'Zoom' }).getAttribute('aria-valuetext')).toBe('150%');
  expect(within(dialog).getByRole('group', { name: 'Attached files' }).querySelectorAll('img')).toHaveLength(2);
  expect([...within(dialog).getByRole('group', { name: 'Attached files' }).querySelectorAll('img')].every(image => image.getAttribute('loading') === 'lazy')).toBe(true);
  // Cards load once; opening revalidates the selected file, not every filmstrip item.
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close dialog' }), { key: 'ArrowRight' });
  expect(screen.getByRole('dialog', { name: 'a.png' })).toBe(dialog);
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close dialog' }), { key: '0' });
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close dialog' }), { key: 'ArrowRight' });
  await screen.findByRole('dialog', { name: 'b.png' });
  expect(await within(dialog).findByRole('img', { name: 'b.png' })).toBeTruthy();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('groups images ahead of mixed files and keeps the viewer in the displayed order', async () => {
  const image = { kind: 'image', mime: 'image/webp', width: 200, height: 100 } as const;
  previews({ doc: { kind: 'office', fileType: 'docx' }, a: image, zip: { kind: 'unsupported', reason: 'unsupported_format' }, b: image });
  render(<AssetAttachments assets={[asset('doc', 'notes.docx'), asset('a'), asset('zip', 'archive.zip'), asset('b')]} />);
  const attachments = screen.getByRole('group', { name: 'Message attachments' });
  await waitFor(() => expect([...attachments.children].map(el => el.querySelector('.asset-image-button img')?.getAttribute('alt') ?? el.querySelector('.asset-filename > span')?.textContent))
    .toEqual(['a.png', 'b.png', 'notes.docx', 'archive.zip']));
  expect(attachments.classList.contains('asset-attachments--gallery')).toBe(true);
  const firstPage = within(attachments).getByRole('img', { name: 'First page of notes.docx' });
  expect(firstPage.getAttribute('src')).toBe('/v1/assets/doc/thumbnail');
  fireEvent.error(firstPage);
  expect(within(attachments).getByText('Word document · 1 KB')).toBeTruthy();
  expect(within(attachments).getByText('ZIP file · 1 KB')).toBeTruthy();
  expect(within(attachments).getByRole('link', { name: 'Download notes.docx' })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(4);
  await userEvent.click(within(attachments).getByRole('button', { name: 'Preview b.png' }));
  expect(within(await screen.findByRole('dialog')).getByText('2 of 4')).toBeTruthy();
});
it('offers high-density static previews and opens the overflow tile in the viewer', async () => {
  const image = { kind: 'image', mime: 'image/webp', width: 2400, height: 1200 } as const;
  previews({ a: image, b: image, c: image });
  render(<AssetAttachments assets={[asset('a'), asset('b'), asset('c')]} />);
  const first = await screen.findByRole('img', { name: 'a.png' });
  await waitFor(() => expect(first.getAttribute('srcset')).toBe('/v1/assets/a/thumbnail 360w, /v1/assets/a/content 1600w'));
  await userEvent.click(await screen.findByRole('button', { name: 'View 2 more images, starting with b.png' }));
  const dialog = await screen.findByRole('dialog', { name: 'b.png' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next file' }));
  expect(await screen.findByRole('dialog', { name: 'c.png' })).toBeTruthy();
});
it('updates an open image title and alt text while retaining its original image element and zoom', async () => {
  let refresh!: () => unknown;
  const sub = vi.spyOn(live, 'subscribeUpdates').mockImplementation((_scope, _id, read) => {
    refresh = read;
    return () => {};
  });
  const initial = { id:'a', name:'a.png', description:'', uploader:'Kai', shared_at:'2026-11-12T02:00:00Z', channel_id:'channel', can_edit:true };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url.endsWith('/details') ? { ...initial, name:'renamed.png', description:'Sky at night' }
      : { kind:'image', width:2000, height:1000, mime:'image/webp', details:initial },
  })));
  try {
    render(<AssetAttachments assets={[asset('a')]} />);
    await userEvent.click(await screen.findByRole('button', { name:'Preview a.png' }));
    const viewer = await screen.findByRole('dialog');
    await userEvent.click(await within(viewer).findByRole('button', { name:'Zoom in' }));
    const image = within(viewer).getByRole('img', { name:'a.png' });
    expect(image.getAttribute('src')).toBe('/v1/assets/a/original-image');
    await act(async () => { await refresh(); });
    expect(screen.getByRole('dialog', { name:'renamed.png' })).toBe(viewer);
    expect(within(viewer).getByRole('img', { name:'Sky at night' })).toBe(image);
    expect((within(viewer).getByRole('slider') as HTMLInputElement).getAttribute('aria-valuetext')).toBe('150%');
  } finally { sub.mockRestore(); }
});
it('zooms the original image through pixel-scale stops, anchors a pinch, and resets to fit', async () => {
  previews({ a: { kind: 'image', mime: 'image/png', width: 1766, height: 1856 } });
  const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1456);
  const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(722);
  try {
    render(<AssetAttachments assets={[asset('a')]} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Preview a.png' }));
    const dialog = await screen.findByRole('dialog');
    const image = await within(dialog).findByRole('img', { name: 'a.png' });
    Object.defineProperties(image, { naturalWidth: { value: 1766 }, naturalHeight: { value: 1856 } });
    fireEvent.load(image);
    const slider = within(dialog).getByRole('slider', { name: 'Zoom' });
    const level = () => slider.getAttribute('aria-valuetext');
    expect(level()).toBe('39%');
    for (const expected of ['50%', '100%', '150%', '200%']) {
      fireEvent.keyDown(image, { key: '+' });
      expect(level()).toBe(expected);
    }
    fireEvent.keyDown(image, { key: '-' });
    expect(level()).toBe('150%');
    fireEvent.wheel(image, { deltaY: -10, ctrlKey: true, clientX: 100 });
    expect(level()).toBe('160%');
    expect(image.style.transform).not.toContain('translate(0px, 0px)');
    fireEvent.keyDown(image, { key: '0' });
    expect(level()).toBe('39%');
    expect(image.style.transform).toContain('translate(0px, 0px)');
  } finally { width.mockRestore(); height.mockRestore(); }
});
it('shows a lazy PDF first-page thumbnail without loading the PDF and keeps preview and download separate', async () => {
  previews({ pdf: { kind: 'pdf', mime: 'application/pdf' } });
  render(<AssetAttachments assets={[asset('pdf', 'report.pdf')]} />);
  const image = await screen.findByRole('img', { name: 'First page of report.pdf' });
  expect(image.getAttribute('src')).toBe('/v1/assets/pdf/thumbnail');
  expect(image.getAttribute('loading')).toBe('lazy');
  expect(document.querySelector('canvas,iframe,object')).toBeNull();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Open report.pdf' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download report.pdf' }).getAttribute('href')).toBe('/v1/assets/pdf/download');
  fireEvent.error(image);
  expect(screen.queryByRole('img', { name: 'First page of report.pdf' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Preview report.pdf' })).toBeTruthy();
  expect(screen.queryByText('Preview unavailable')).toBeNull();
});
it('renders HTML as bounded source text, shows truncation, and leaves unsupported files downloadable', async () => {
  const text = '<script>window.bad = true</script>\n' + 'x'.repeat(4000);
  previews({ html: { kind: 'text', language: 'html', text, truncated: true }, zip: { kind: 'unsupported', reason: 'unsupported_format' } });
  const { container } = render(<AssetAttachments assets={[asset('html', 'source.html'), asset('zip', 'archive.zip')]} />);
  await screen.findByText('Text preview');
  expect(container.querySelector('script,iframe,object')).toBeNull();
  expect(container.querySelector('.asset-snippet')!.textContent!.length).toBeLessThan(2500);
  await userEvent.click(await screen.findByRole('button', { name: 'Open preview of source.html' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Showing the first 256 KiB. Download to read the complete file.')).toBeTruthy();
  expect(dialog.querySelector('pre')!.textContent).toBe(text);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next file' }));
  expect(await within(dialog).findByText('Preview unavailable')).toBeTruthy();
  expect(within(dialog).getByRole('link', { name: 'Download original' }).getAttribute('href')).toBe('/v1/assets/zip/download');
});
it('ignores stale preview responses after assets change and aborts in-flight requests on unmount', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/a/') ? pending : { ok: false, status: 403 }));
  const view = render(<AssetAttachments assets={[asset('a')]} />);
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  view.rerender(<AssetAttachments assets={[asset('b')]} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { finish({ ok: true, json: async () => ({ kind: 'image', mime: 'image/webp', width: 10, height: 10 }) }); });
  expect(screen.queryByRole('img')).toBeNull();
  expect(await screen.findByText('Preview unavailable')).toBeTruthy();
  const lastSignal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal!;
  view.unmount();
  expect(lastSignal.aborted).toBe(true);
});
it('removes cached content if reopening loses access and handles native media codec errors', async () => {
  let revoked = false;
  vi.stubGlobal('fetch', vi.fn(async () => revoked ? { ok: false, status: 404 } : { ok: true, json: async () => ({ kind: 'audio', mime: 'audio/mpeg' }) }));
  render(<AssetAttachments assets={[asset('a', 'song.mp3')]} />);
  await waitFor(() => expect(document.querySelector('audio[controls]')).toBeTruthy());
  fireEvent.error(document.querySelector('audio')!);
  expect(await screen.findByText('Preview unavailable')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Preview song.mp3' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog.querySelector('audio')).toBeTruthy());
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  revoked = true;
  await userEvent.click(screen.getByRole('button', { name: 'Preview song.mp3' }));
  expect(await within(await screen.findByRole('dialog')).findByText('Preview unavailable')).toBeTruthy();
  expect(screen.getByRole('dialog').querySelector('audio')).toBeNull();
});
it.each([
  ['newlines', '\n'.repeat(262144)],
  ['single line', 'x'.repeat(262144)],
  ['multibyte single line', '漢'.repeat(80000)],
])('bounds full text viewer code and line nodes for %s', async (_name, text) => {
  previews({ source: { kind: 'text', language: 'text', text, truncated: false } });
  render(<AssetAttachments assets={[asset('source', 'large.txt')]} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Open preview of large.txt' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(/Preview shortened/);
  const code = dialog.querySelector('pre')!;
  expect(code.textContent!.length).toBeLessThanOrEqual(20000);
  expect(new TextEncoder().encode(code.textContent!).byteLength).toBeLessThanOrEqual(32768);
  expect(dialog.querySelectorAll('.sp-code-gutter>span').length).toBeLessThanOrEqual(1000);
  expect(within(dialog).getByRole('link', { name: 'Download original' }).getAttribute('href')).toBe('/v1/assets/source/download');
});
it('labels the viewer with the validated preview kind and MIME rather than the upload type', async () => {
  previews({ a: { kind: 'image', mime: 'image/webp', width: 200, height: 100 } });
  render(<AssetAttachments assets={[{ ...asset('a'), type: 'text/html' }]} />);
  await screen.findByRole('img', { name: 'a.png' });
  await userEvent.click(screen.getByRole('button', { name: 'Preview a.png' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Image · image/webp')).toBeTruthy();
  expect(dialog.textContent).not.toContain('text/html');
});
it('drops a trailing high surrogate when the text limit splits an emoji', async () => {
  const prefix = 'a'.repeat(19999);
  previews({ source: { kind: 'text', language: 'text', text: `${prefix}😀`, truncated: false } });
  render(<AssetAttachments assets={[asset('source', 'emoji.txt')]} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Open preview of emoji.txt' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(/Preview shortened/);
  expect(dialog.querySelector('pre')!.textContent).toBe(prefix);
});

it('exports a viewer for lightweight file kinds without fetching every filmstrip entry', async () => {
  const { AssetViewer } = await import('./AssetAttachments.js');
  previews({ a: { kind: 'unsupported', reason: 'unsupported_format' } });
  render(<AssetViewer assets={[asset('a'), asset('b')]} selectedId="a" onSelect={() => {}} onClose={() => {}} previews={{ a: { kind: 'file' }, b: { kind: 'image' } }} />);
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Preview unavailable')).toBeTruthy();
  expect(within(dialog).getByRole('group', { name: 'Attached files' }).querySelectorAll('img')).toHaveLength(1);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});

it('opens Markdown as formatted text and does not load embedded HTML or remote images', async () => {
  previews({ md: { kind: 'text', language: 'markdown', text: '# Billing runbook\n\n- Check the ledger\n\n![logo](https://example.org/logo.png)\n\n<script>bad()</script>', truncated: false } });
  render(<AssetAttachments assets={[asset('md', 'billing.md')]} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Open preview of billing.md' }));
  const dialog = screen.getByRole('dialog');
  expect(await within(dialog).findByRole('heading', { name: 'Billing runbook' })).toBeTruthy();
  expect(within(dialog).getByRole('listitem').textContent).toBe('Check the ledger');
  expect(dialog.querySelector('img, script')).toBeNull();
});
