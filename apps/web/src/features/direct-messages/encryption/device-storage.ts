import type { DeviceIdentity, Trust } from './crypto.js';

export type DeviceState = { identity: DeviceIdentity; recovery: string; linked?: boolean; trust?: Trust };
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('space-dm-devices', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('devices');
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
  }));
}
export async function deviceState(
  actor: string,
  channel: string,
  update?: (old: DeviceState | undefined) => DeviceState,
): Promise<DeviceState | undefined> {
  const db = await database(),
    key = [actor, channel];
  return new Promise((resolve, reject) => {
    const tx = db.transaction('devices', update ? 'readwrite' : 'readonly'),
      store = tx.objectStore('devices'),
      read = store.get(key);
    let value: DeviceState | undefined, failure: unknown;
    read.onsuccess = () => {
      try {
        value = read.result;
        if (update) {
          value = update(value);
          store.put(value, key);
        }
      } catch (e) {
        failure = e;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Device storage unavailable.'));
  });
}
