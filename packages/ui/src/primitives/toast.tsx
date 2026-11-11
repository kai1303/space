import { useSyncExternalStore, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { Toaster as DingToaster, toast } from '@yusufceng1z/ding-react';

export { toast };

// Native modal dialogs make everything outside the top dialog inert.
const dialogs = new Set<HTMLDialogElement>();
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
export function registerToastDialog(dialog: HTMLDialogElement) {
  dialogs.add(dialog);
  notify();
  return () => { dialogs.delete(dialog); notify(); };
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const currentDialog = () => Array.from(dialogs).at(-1) ?? null;
export function Toaster(props: ComponentProps<typeof DingToaster>) {
  const dialog = useSyncExternalStore(subscribe, currentDialog, () => null);
  const viewport = <DingToaster {...props} />;
  return dialog ? createPortal(viewport, dialog) : viewport;
}

let operation = 0;
export function pendingToast(title: string) {
  // Ding merges identical titles unless each operation has its own caller ID.
  return toast.loading(title, { id: `space-action-${++operation}` });
}
