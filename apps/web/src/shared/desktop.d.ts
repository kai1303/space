import type { LocalProvider } from '@space/contracts';

declare global {
  interface Window {
    spaceOffice?: {
      openFile(id: string): Promise<boolean>;
      onClose(fn: (close: () => void) => void): () => void;
    };
    spaceDesktop?: {
      openOffice?(kind: 'library' | 'file', id: string): Promise<boolean>;
      onOfficePicker?(fn: () => void): () => void;
      pair(provider: LocalProvider, code: string): Promise<void>;
      openWorkspacePanel?(): void;
      hideWorkspacePanel?(): void;
      openBrowser?(): void;
      browserAccountChanged?(id: string | null): void;
    };
  }
}
