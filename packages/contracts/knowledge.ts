// The host supplies this context after authorizing a tool call. Agent input contains only request/ref.
export interface KnowledgeContext {
  workspaceId: string;
  connectionId: string;
  requesterId: string;
  installationId: string;
  audience: { kind: 'channel'; channelId: string };
}
export interface KnowledgeManifest {
  apiVersion: 1;
  name: string;
  description: string;
  filters?: { key: string; description: string; values?: string[] }[];
}
export interface KnowledgeRef {
  connectionId: string;
  recordId: string;
}
export interface KnowledgeHit {
  ref: KnowledgeRef;
  title: string;
  evidence: string;
  citation: { label: string; url: string };
  facts?: { subject: KnowledgeRef; predicate: string; value: string | KnowledgeRef }[];
}
export interface KnowledgeSearch {
  query: string;
  filters?: Record<string, string>;
  limit: number;
  cursor?: string;
}
export interface KnowledgePage {
  hits: KnowledgeHit[];
  nextCursor?: string;
}
export interface KnowledgePluginV1 {
  manifest: KnowledgeManifest;
  search(context: KnowledgeContext, request: KnowledgeSearch): Promise<KnowledgePage>;
  resolve?(context: KnowledgeContext, ref: KnowledgeRef): Promise<KnowledgeHit | null>;
}
