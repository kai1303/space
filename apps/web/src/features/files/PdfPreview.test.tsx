import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfPreview } from './PdfPreview.js';

const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), destroy: vi.fn(), cancel: vi.fn(), render: vi.fn(), getPage: vi.fn(), receive: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {},
  PDFDataRangeTransport: class {
    constructor(public length: number, public initialData: Uint8Array, public progressiveDone: boolean) {}
    onDataRange = mocks.receive;
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }));

const size = 300_000;
const transport = () => mocks.getDocument.mock.calls.at(-1)![0].range as { length: number; initialData: Uint8Array; progressiveDone: boolean; requestDataRange: (begin: number, end: number) => void };
function response(begin: number, end: number, overrides: Record<string, string> = {}) {
  return new Response(new Uint8Array(end - begin), { status: 206, headers: {
    'Content-Type': 'application/pdf', 'Content-Length': String(end - begin), 'Content-Range': `bytes ${begin}-${end - 1}/${size}`, ...overrides,
  } });
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => response(0, 65_536)));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as any);
  mocks.render.mockImplementation(() => ({ promise: Promise.resolve(), cancel: mocks.cancel }));
  mocks.getPage.mockImplementation(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 8000 * scale, height: 10000 * scale }), render: mocks.render, cleanup: vi.fn() }));
  mocks.destroy.mockResolvedValue(undefined);
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage: mocks.getPage }), destroy: mocks.destroy });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it('starts PDF.js with an empty demand-driven transport and no eager content request', async () => {
  render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  expect(fetch).not.toHaveBeenCalled();
  expect(transport()).toMatchObject({ length: size, initialData: new Uint8Array(0), progressiveDone: true });
  expect(mocks.getDocument.mock.calls[0]![0]).toMatchObject({ length: size, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65_536, isEvalSupported: false, stopAtErrors: true });
  expect(mocks.getDocument.mock.calls[0]![0]).not.toHaveProperty('data');
});
it('requests authenticated same-origin ranges and delivers only validated bytes to PDF.js', async () => {
  render(<PdfPreview assetId="report/one" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  await waitFor(() => expect(mocks.receive).toHaveBeenCalledWith(0, new Uint8Array(65_536)));
  expect(fetch).toHaveBeenCalledWith('/v1/assets/report%2Fone/content', expect.objectContaining({ credentials: 'same-origin', headers: { Range: 'bytes=0-65535' }, signal: expect.any(AbortSignal) }));
});
it('accepts coalesced PDF.js ranges and clamps the final exclusive boundary to the file size', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(65_536, 196_608)).mockResolvedValueOnce(response(262_144, size));
  render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => { transport().requestDataRange(65_536, 196_608); transport().requestDataRange(262_144, 327_680); });
  await waitFor(() => expect(mocks.receive).toHaveBeenCalledTimes(2));
  expect(mocks.receive).toHaveBeenCalledWith(65_536, new Uint8Array(131_072));
  expect(mocks.receive).toHaveBeenCalledWith(262_144, new Uint8Array(size - 262_144));
  expect(vi.mocked(fetch).mock.calls[1]![1]!.headers).toEqual({ Range: 'bytes=262144-299999' });
});
it('paginates, zooms, bounds the canvas and cancels rendering on close', async () => {
  const view = render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  const canvas = view.container.querySelector('canvas')!;
  await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_777_216);
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(8192);
  await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Page 2 of 3');
  await waitFor(() => expect(mocks.getPage).toHaveBeenCalledWith(2));
  await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByRole('button', { name: 'Fit PDF' }).textContent).toBe('125%');
  expect(mocks.cancel).toHaveBeenCalled();
  view.unmount();
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it('aborts outstanding ranges on close and ignores late responses', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(response(0, 65_536)); });
  expect(mocks.receive).not.toHaveBeenCalled();
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it.each([{ assetId: 'other', size }, { assetId: 'report', size: size + 1 }])('replaces the transport and cancels stale requests when metadata changes: %j', async next => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  const old = transport();
  act(() => old.requestDataRange(0, 65_536));
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  view.rerender(<PdfPreview {...next} />);
  await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
  expect(signal.aborted).toBe(true);
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
  expect(transport()).not.toBe(old);
  await act(async () => { resolve(response(0, 65_536)); old.requestDataRange(65_536, 131_072); });
  expect(mocks.receive).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 403])('stops revoked range reads (%s) and preserves session expiration handling', async status => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
  const sessionExpired = vi.fn();
  window.addEventListener('space:session-expired', sessionExpired);
  const view = render(<PdfPreview assetId="revoked" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'PDF preview unavailable. Download the original to open it.');
  expect(sessionExpired).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
  expect(mocks.receive).not.toHaveBeenCalled();
  view.unmount();
  window.removeEventListener('space:session-expired', sessionExpired);
});
it.each([
  ['full response', () => new Response(new Uint8Array(65_536), { status: 200 })],
  ['wrong content range', () => response(0, 65_536, { 'Content-Range': `bytes 1-65536/${size}` })],
  ['wrong total size', () => response(0, 65_536, { 'Content-Range': `bytes 0-65535/${size + 1}` })],
  ['wrong declared length', () => response(0, 65_536, { 'Content-Length': '9' })],
  ['wrong content type', () => response(0, 65_536, { 'Content-Type': 'text/html' })],
  ['short body', () => new Response(new Uint8Array(8), { status: 206, headers: { 'Content-Type': 'application/pdf', 'Content-Length': '65536', 'Content-Range': `bytes 0-65535/${size}` } })],
] as const)('rejects %s without delivering corrupt bytes', async (_label, makeResponse) => {
  vi.mocked(fetch).mockResolvedValue(makeResponse());
  render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  await screen.findByRole('alert');
  expect(mocks.receive).not.toHaveBeenCalled();
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it('destroys the loading task if PDF parsing fails', async () => {
  mocks.getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error('invalid PDF')), destroy: mocks.destroy }));
  render(<PdfPreview assetId="invalid" size={size} />);
  await screen.findByRole('alert');
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
it('stops the loading task and range reads after a render error', async () => {
  mocks.render.mockImplementation(() => ({ promise: Promise.reject(new Error('render failed')), cancel: mocks.cancel }));
  render(<PdfPreview assetId="report" size={size} />);
  await screen.findByRole('alert');
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
  act(() => transport().requestDataRange(0, 65_536));
  expect(fetch).not.toHaveBeenCalled();
});
it('ignores a document that finishes loading after a replacement opens', async () => {
  let resolve!: (document: { numPages: number; getPage: typeof mocks.getPage }) => void;
  mocks.getDocument.mockReturnValueOnce({ promise: new Promise(done => { resolve = done; }), destroy: mocks.destroy });
  const view = render(<PdfPreview assetId="old" size={size} />);
  view.rerender(<PdfPreview assetId="new" size={size} />);
  await screen.findByText('Page 1 of 3');
  await act(async () => { resolve({ numPages: 99, getPage: mocks.getPage }); });
  expect(screen.queryByText('Page 1 of 99')).toBeNull();
  expect(screen.getByText('Page 1 of 3')).toBeTruthy();
});
it('ignores expired-session responses that arrive after close', async () => {
  let resolve!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done; }));
  const event = vi.spyOn(window, 'dispatchEvent');
  const view = render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  view.unmount();
  await act(async () => { resolve(new Response(null, { status: 401 })); });
  expect(event).not.toHaveBeenCalled();
});
it('shows a fallback and stops all range work after a network error', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  act(() => transport().requestDataRange(0, 65_536));
  await screen.findByRole('alert');
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
  act(() => transport().requestDataRange(65_536, 131_072));
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('handles a rejected PDF.js destroy operation during cleanup', async () => {
  mocks.destroy.mockRejectedValue(new Error('worker already closed'));
  const view = render(<PdfPreview assetId="report" size={size} />);
  await screen.findByText('Page 1 of 3');
  await act(async () => { view.unmount(); });
  expect(mocks.destroy).toHaveBeenCalledTimes(1);
});
