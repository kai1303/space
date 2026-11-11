import { toast } from '@yusufceng1z/ding-react';

export { Toaster, toast } from '@yusufceng1z/ding-react';

let operation = 0;
export function pendingToast(title: string) {
  // Ding merges identical titles unless each operation has its own caller ID.
  return toast.loading(title, { id: `space-action-${++operation}` });
}
