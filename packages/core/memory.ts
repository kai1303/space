import type { MemoryDocument, MemoryMatch, MemoryScope, MemorySource } from '@space/contracts';

// Providers own atomic revision checks and concurrent mutation safety across replicas.
// Callers authorize before work and recheck access before returning results.
// Retrieved content is reference data and must never confer agent instructions/grants.
export interface MemoryProvider {
  readonly id: string;
  readonly name: string;
  read(scope: MemoryScope): Promise<MemoryDocument>;
  write(scope: MemoryScope, content: string, expectedRevision: string): Promise<MemoryDocument>;
  ingest(scope: MemoryScope, source: MemorySource): Promise<MemoryDocument>;
  remove(scope: MemoryScope, sourceId: string): Promise<MemoryDocument>;
  search(scope: MemoryScope, query: string): Promise<MemoryMatch[]>;
  clear(scope: MemoryScope): Promise<void>;
}
