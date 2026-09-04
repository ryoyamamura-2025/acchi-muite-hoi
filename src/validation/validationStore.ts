import { DB_NAME, DB_VERSION, STORE_NAMES } from '../data/database';
import type { ValidationSessionRecord } from './types';

export interface ValidationStore {
  put(record: ValidationSessionRecord): Promise<void>;
  list(): Promise<ValidationSessionRecord[]>;
  clear(): Promise<void>;
}

export function createIndexedDbValidationStore(): ValidationStore {
  return new IndexedDbValidationStore();
}

class IndexedDbValidationStore implements ValidationStore {
  async put(record: ValidationSessionRecord): Promise<void> {
    await withStore('readwrite', (store) => {
      store.put(structuredClone(record));
    });
  }

  async list(): Promise<ValidationSessionRecord[]> {
    return withStore('readonly', async (store) => {
      const records = await requestToPromise<ValidationSessionRecord[]>(store.getAll());
      return structuredClone(records);
    });
  }

  async clear(): Promise<void> {
    await withStore('readwrite', (store) => {
      store.clear();
    });
  }
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const db = await openExistingDatabase();
  try {
    const tx = db.transaction(STORE_NAMES.validationSessions, mode);
    const done = transactionDone(tx);
    const result = await action(tx.objectStore(STORE_NAMES.validationSessions));
    await done;
    return result;
  } finally {
    db.close();
  }
}

function openExistingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let upgradeAttempted = false;
    request.onupgradeneeded = () => {
      // ValidationはModelService初期化後のみ許可する。ここでschemaを独自生成しない。
      upgradeAttempted = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      if (upgradeAttempted) {
        request.result.close();
        reject(new Error('Validation storeはDatabase初期化後に使用してください'));
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE_NAMES.validationSessions)) {
        request.result.close();
        reject(new Error('validationSessions storeが見つかりません'));
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Validation databaseを開けませんでした'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}
