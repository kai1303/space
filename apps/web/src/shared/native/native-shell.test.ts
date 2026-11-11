import { describe, expect, it, vi } from 'vitest';
import { handleBack, isNativeShell, startNativeShell, type NativeApi } from './native-shell.js';

const api = () => {
  let back: ((event: { canGoBack: boolean }) => void) | undefined;
  const remove = vi.fn(async () => {});
  const value: NativeApi = {
    hideSplash: vi.fn(async () => {}),
    onBack: vi.fn(async handler => { back = handler; return { remove }; }),
    minimize: vi.fn(async () => {}),
  };
  return { value, remove, press: (canGoBack: boolean) => back?.({ canGoBack }) };
};

describe('native shell', () => {
  it('does nothing in a browser', async () => {
    const load = vi.fn();
    expect(isNativeShell(window)).toBe(false);
    await startNativeShell(window, load);
    expect(load).not.toHaveBeenCalled();
  });

  it('hides the splash and wires the back button inside the app', async () => {
    const native = api(), win = Object.assign(Object.create(window), { Capacitor: { isNativePlatform: () => true }, document, history: { back: vi.fn() } });
    const stop = await startNativeShell(win, async () => native.value);
    expect(native.value.hideSplash).toHaveBeenCalledOnce();
    native.press(false);
    expect(native.value.minimize).toHaveBeenCalledOnce();
    stop();
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it('presses the innermost visible back arrow first', () => {
    document.body.innerHTML = '<div class="chat-main-area"><button class="chat-conversation-back" id="a"></button><button class="chat-conversation-back" id="b"></button><button class="chat-conversation-back" id="hidden"></button></div>';
    const a = document.getElementById('a')!, b = document.getElementById('b')!, hidden = document.getElementById('hidden')!;
    const clicks: string[] = [];
    for (const button of [a, b]) button.getClientRects = () => [{}] as unknown as DOMRectList;
    hidden.getClientRects = () => [] as unknown as DOMRectList;
    for (const button of [a, b, hidden]) button.addEventListener('click', () => clicks.push(button.id));
    const history = { back: vi.fn() }, minimize = vi.fn(async () => {});
    handleBack(document, { canGoBack: true }, { minimize }, history);
    expect(clicks).toEqual(['b']);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('goes back in history, then leaves the app, when no back arrow shows', () => {
    document.body.innerHTML = '';
    const history = { back: vi.fn() }, minimize = vi.fn(async () => {});
    handleBack(document, { canGoBack: true }, { minimize }, history);
    expect(history.back).toHaveBeenCalledOnce();
    handleBack(document, { canGoBack: false }, { minimize }, history);
    expect(minimize).toHaveBeenCalledOnce();
  });
});
