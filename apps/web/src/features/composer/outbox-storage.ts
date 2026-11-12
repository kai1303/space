import type { OutboxEntry } from './message-outbox.js';

let opening: Promise<IDBDatabase> | undefined;
function openDatabase() {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('space-message-outbox', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('queues');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => { opening = undefined; };
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
    }).catch(error => { opening = undefined; throw error; });
  }
  return opening;
}

// A bounded queue per actor/workspace. Compare and write inside one transaction across all tabs.
export async function transactOutbox(scope: string, change?: (rows: OutboxEntry[]) => OutboxEntry[]) {
  const db = await openDatabase();
  return new Promise<{ rows: OutboxEntry[]; changed: boolean }>((resolve, reject) => {
    const tx = db.transaction('queues', change ? 'readwrite' : 'readonly');
    const store = tx.objectStore('queues');
    const read = store.get(scope);
    let rows: OutboxEntry[] = [], changed = false, failure: unknown;
    read.onsuccess = () => {
      try {
        const previous = (read.result ?? []) as OutboxEntry[];
        rows = change ? change(previous) : previous;
        changed = rows !== previous;
        if (changed && rows.length) store.put(rows, scope);
        else if (changed) store.delete(scope);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Local outbox write failed'));
    tx.oncomplete = () => resolve({ rows, changed });
  });
}
