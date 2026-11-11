// Glue for the Capacitor shell (apps/capacitor). In a browser this does nothing and loads no plugin code.
type Bridge = { isNativePlatform?: () => boolean };
type BackEvent = { canGoBack: boolean };
export type NativeApi = {
  hideSplash: () => Promise<void>;
  onBack: (handler: (event: BackEvent) => void) => Promise<{ remove: () => Promise<void> }>;
  minimize: () => Promise<void>;
};

export function isNativeShell(win: Window = window): boolean {
  return !!(win as Window & { Capacitor?: Bridge }).Capacitor?.isNativePlatform?.();
}

// Android's hardware back button follows the same path as the on-screen back arrow and edge swipe.
export function handleBack(root: ParentNode, event: BackEvent, api: Pick<NativeApi, 'minimize'>, history: Pick<History, 'back'> = window.history) {
  const back = [...root.querySelectorAll<HTMLElement>('.chat-main-area .chat-conversation-back')].filter(button => button.getClientRects().length).at(-1);
  if (back) back.click();
  else if (event.canGoBack) history.back();
  else void api.minimize();
}

async function loadApi(): Promise<NativeApi> {
  const [{ App }, { SplashScreen }] = await Promise.all([import('@capacitor/app'), import('@capacitor/splash-screen')]);
  return {
    hideSplash: () => SplashScreen.hide(),
    onBack: handler => App.addListener('backButton', handler),
    minimize: () => App.minimizeApp(),
  };
}

export async function startNativeShell(win: Window = window, load: () => Promise<NativeApi> = loadApi): Promise<() => void> {
  if (!isNativeShell(win)) return () => {};
  const api = await load();
  await api.hideSplash().catch(() => {});
  const listener = await api.onBack(event => handleBack(win.document, event, api, win.history));
  return () => { void listener.remove(); };
}
