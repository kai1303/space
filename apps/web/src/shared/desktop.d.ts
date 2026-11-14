import type { LocalProvider } from '@space/contracts';

declare global {
  interface Window {
    spaceOffice?: {
      checkEditAccess(key: string): Promise<void>;
      ask?(goal: string, selection: string, key: string, previousDraft?: string): Promise<{ message: string; replacement?: string }>;
      cancel?(): void;
      openFile(id: string): Promise<boolean>;
      onClose(fn: (close: () => void) => void): () => void;
    };
    spaceDesktop?: {
      vaultItemRequest?(actor:string, change?:import('@space/contracts').VaultChange): Promise<import('@space/contracts').VaultPage | import('@space/contracts').VaultChangeResult>;
      saveLinearToken?(actor: string, title: string, token: string): Promise<import('@space/contracts').WebVaultResult>;
      listVaultItems?(actor: string): Promise<import('@space/contracts').WebVaultResult>;
      onVaultLocked?(fn: () => void): () => void;
      onVaultPage?(fn: () => void): () => void;
      openVault?(actor: string): Promise<string>;
      saveBrowserVaultToken?(endpoint: string): Promise<string>;
      onBrowserMcpSetup?(fn: (site: {name: string; url: string; showGuide?: boolean; actor: string}) => void): () => void;
      onBrowserSidekick?(fn: (tab: {tab: string; page: string; actor: string} | null) => void): () => void;
      browserSessionId?(tab: string, workspace: string): Promise<string | null>;
      dismissBrowserSidekick?(tab: string): void;
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
