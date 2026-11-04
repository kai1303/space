import { normalizeDocument, type RichDocument } from '@space/ui/rich-text';
export type ComposerDrafts = Record<string, RichDocument>;
const storageKey = (viewer: string) => `space:composer-drafts:${viewer}`;
export function readComposerDrafts(viewer: string): ComposerDrafts {
  try {
    const raw = localStorage.getItem(storageKey(viewer));
    if (!raw || raw.length > 500_000) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(-100).flatMap(([key, document]) => {
      if (!document || typeof document !== 'object' || !Array.isArray((document as RichDocument).ops)) return [];
      const normalized = normalizeDocument(document as RichDocument);
      return normalized.ops.some(op => op.insert.trim()) ? [[key, normalized]] : [];
    }));
  } catch { return {}; }
}
export function persistComposerDrafts(viewer: string, drafts: ComposerDrafts) {
  try {
    const entries = Object.entries(drafts).filter(([, doc]) => doc.ops.some(op => op.insert.trim())).slice(-100);
    const serialized = JSON.stringify(Object.fromEntries(entries));
    if (serialized.length <= 500_000) localStorage.setItem(storageKey(viewer), serialized);
  } catch { /* In-memory drafts still work when browser storage is unavailable. */ }
}
