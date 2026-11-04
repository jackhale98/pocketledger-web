// A minimal promise wrapper over IndexedDB: open with an upgrade callback,
// run a transaction, await a request. Enough for the vault store; no
// dependency (Mycelium used Dexie — see docs/SYNC.md for why we don't).

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion, req.transaction!);
    req.onsuccess = () => {
      const db = req.result;
      // Let another tab with a newer schema upgrade instead of hanging on us.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error(`Could not open ${name}`));
    req.onblocked = () => reject(new Error(`${name} is open in an older tab; close it and reload`));
  });
}

/**
 * Run `body` inside one transaction and resolve with its return value once
 * the transaction commits. `body` must only issue IndexedDB requests (no
 * awaiting other promises), or the transaction auto-commits early.
 */
export function transact<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    try {
      result = body(tx);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
}

export function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
