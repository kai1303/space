import type { LocalProvider } from '@space/contracts';

declare global {
  interface Window {
    spaceDesktop?: {
      pair(provider: LocalProvider, code: string): Promise<void>;
      openBrowser?(): void;
      browserAccountChanged?(id: string | null): void;
    };
  }
}
