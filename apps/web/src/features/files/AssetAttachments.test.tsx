import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AssetAttachment, AssetPreview } from '@space/contracts';
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
it('shows server-approved image thumbnails and navigates files in a shared viewer with focus return', async () => {
  previews({ a: { kind: 'image', mime: 'image/webp', width: 1200, height: 600 }, b: { kind: 'image', mime: 'image/gif', width: 500, height: 800 } });
  render(<AssetAttachments assets={[asset('a'), asset('b')]} />);
  expect((await screen.findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('/v1/assets/a/thumbnail');
  expect(screen.getByRole('link', { name: 'Download a.png' }).getAttribute('href')).toBe('/v1/assets/a/download');
  const opener = screen.getByRole('button', { name: 'Preview a.png' });
  await userEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'a.png' });
  expect((await within(dialog).findByRole('img', { name: 'a.png' })).getAttribute('src')).toBe('/v1/assets/a/content');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
  expect(within(dialog).getByRole('button', { name: /Fit image/ }).textContent).toContain('125%');
  expect(within(dialog).getByRole('group', { name: 'Attached files' }).querySelectorAll('img')).toHaveLength(2);
  expect([...within(dialog).getByRole('group', { name: 'Attached files' }).querySelectorAll('img')].every(image => image.getAttribute('loading') === 'lazy')).toBe(true);
  // Cards load once; opening revalidates the selected file, not every filmstrip item.
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close dialog' }), { key: 'ArrowRight' });
  await screen.findByRole('dialog', { name: 'b.png' });
  expect(await within(dialog).findByRole('img', { name: 'b.png' })).toBeTruthy();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(screen.queryByRole('dialog')).toBeNull();
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
  await userEvent.click(screen.getByRole('button', { name: 'Preview source.html' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Preview large.txt' }));
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
  await userEvent.click(screen.getByRole('button', { name: 'Preview emoji.txt' }));
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
