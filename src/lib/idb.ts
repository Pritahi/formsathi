/**
 * Tiny indexedDB wrapper — no dependencies, promise-based.
 *
 * Why not idb/Dexie: the whole storage layer is ~120 lines and the app must
 * boot fast on a cheap phone. Two object stores would not justify a library.
 *
 * Stores
 *  - kv        : settings + vault crypto meta (key/value)
 *  - sessions  : FormSession documents (keyPath id)
 *  - images    : form photos / rendered PDF pages (Blob keyed by string)
 *  - vault     : encrypted answer records (keyPath id, ciphertext only)
 */

const DB_NAME = 'formsathi';
const DB_VERSION = 1;

export const STORE = {
  kv: 'kv',
  sessions: 'sessions',
  images: 'images',
  vault: 'vault',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable in this environment'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE.kv)) {
        db.createObjectStore(STORE.kv);
      }
      if (!db.objectStoreNames.contains(STORE.sessions)) {
        const s = db.createObjectStore(STORE.sessions, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORE.images)) {
        db.createObjectStore(STORE.images);
      }
      if (!db.objectStoreNames.contains(STORE.vault)) {
        db.createObjectStore(STORE.vault, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked — close other tabs'));
  });
  return dbPromise;
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`IDB ${store} ${mode} failed`));
        t.onabort = () => reject(t.error ?? new Error('IDB transaction aborted'));
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<IDBValidKey> {
    return tx<IDBValidKey>(store, 'readwrite', (s) =>
      key === undefined ? s.put(value) : s.put(value, key),
    );
  },
  del(store: StoreName, key: IDBValidKey): Promise<undefined> {
    return tx<undefined>(store, 'readwrite', (s) => s.delete(key) as unknown as IDBRequest<undefined>);
  },
  all<T>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  keys(store: StoreName): Promise<IDBValidKey[]> {
    return tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
  },
  clear(store: StoreName): Promise<undefined> {
    return tx<undefined>(store, 'readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>);
  },
};

/** Convenience: typed kv accessors. */
export const kv = {
  get: <T>(key: string) => idb.get<T>(STORE.kv, key),
  set: <T>(key: string, value: T) => idb.put(STORE.kv, value, key).then(() => value),
  del: (key: string) => idb.del(STORE.kv, key),
};

/** Ask the browser to keep our data (important: vault + sessions are the
 *  product). Silent if unsupported. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
