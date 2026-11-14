import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ClipRecorder } from './clip-recorder.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(getUserMedia: () => Promise<unknown>, kind: 'audio' | 'video' = 'audio') {
  const started = vi.fn();
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { mediaDevices: { getUserMedia } }));
  vi.stubGlobal('MediaRecorder', class {
    static isTypeSupported = (type: string) => type === kind + '/mp4';
    state = 'inactive';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() { started(); this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio']) });
      this.onstop?.();
    }
  });
  const attach = vi.fn();
  const view = render(<ClipRecorder kind={kind} onAttach={attach} disabled={false}/>);
  fireEvent.click(screen.getByRole('button', { name: `Record ${kind} clip` }));
  return { ...view, attach, started };
}

it('releases a late microphone grant when the user cancels or leaves the channel', async () => {
  for (const leave of [false, true]) {
    let grant!: (stream: unknown) => void;
    const pending = new Promise(resolve => { grant = resolve; });
    const { unmount, attach } = setup(() => pending);
    if (leave) unmount();
    else fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const stop = vi.fn();
    await act(async () => grant({ getTracks: () => [{ stop }] }));
    expect(stop).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
    unmount();
  }
});

it('releases the mic before playback and attaches the supported format only on request', async () => {
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = () => 'blob:clip'; static revokeObjectURL = revoke; });
  const stop = vi.fn();
  const { attach } = setup(async () => ({ getTracks: () => [{ stop }] }));
  fireEvent.click(await screen.findByRole('button', { name: 'Finish recording' }));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Preview audio clip').getAttribute('src')).toBe('blob:clip');
  expect(attach).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Attach to message' }));
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ name: 'Audio clip.m4a', type: 'audio/mp4', size: 5 }));
  expect(revoke).toHaveBeenCalledWith('blob:clip');
});

it('shows a live camera preview before recording and releases both devices when discarded', async () => {
  const stopCamera = vi.fn();
  const stopMic = vi.fn();
  const stream = { getTracks: () => [{ stop: stopCamera }, { stop: stopMic }] };
  const { attach, started } = setup(async () => stream, 'video');
  expect(await screen.findByLabelText('Live camera preview')).toHaveProperty('srcObject', stream);
  expect(started).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(stopCamera).toHaveBeenCalledOnce();
  expect(stopMic).toHaveBeenCalledOnce();
  expect(attach).not.toHaveBeenCalled();
});

it('discards an active voice recording from the compact strip', async () => {
  const stop = vi.fn();
  const { attach } = setup(async () => ({ getTracks: () => [{ stop }] }));
  const cancel = await screen.findByRole('button', { name: 'Cancel recording' });
  expect(screen.getByRole('dialog', { name: 'Audio clip' }).querySelectorAll('.sp-voice-waveform i')).toHaveLength(24);
  fireEvent.click(cancel);
  expect(stop).toHaveBeenCalledOnce();
  expect(attach).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
