import type { AnyLabel, Domain } from '../ml/labels';
import type { SimilarityCacheEntry } from '../ml/similarity';
import type { ActiveIndex, Sample } from '../ml/types';

export const DB_NAME = 'acchi-muite-hoi';
/** 旧single-KNN schemaがversion 1なので、新schemaは2から開始する。 */
export const DB_VERSION = 2;

export const STORE_NAMES = {
  meta: 'meta',
  localSamples: 'localSamples',
  importedSamples: 'importedSamples',
  activeIndex: 'activeIndex',
  similarityCache: 'similarityCache',
  validationSessions: 'validationSessions',
} as const;

export type SampleStoreName =
  | typeof STORE_NAMES.localSamples
  | typeof STORE_NAMES.importedSamples;

export interface SampleFilter {
  domain?: Domain;
  label?: AnyLabel;
  sourceInstallationId?: string;
}

export interface DatabasePort {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
  deleteMeta(key: string): Promise<void>;

  getSamples(store: SampleStoreName, filter?: SampleFilter): Promise<Sample[]>;
  putSamples(store: SampleStoreName, samples: readonly Sample[]): Promise<void>;
  clearSampleStore(store: SampleStoreName): Promise<void>;
  /** nextDataRevision指定時はImported置換とrevision更新を同一transactionで確定する。 */
  replaceImportedSource(
    sourceInstallationId: string,
    samples: readonly Sample[],
    nextDataRevision?: number,
  ): Promise<void>;
  /** Localの1 classと対応するsimilarity cacheを同一transactionで置換する。 */
  commitLocalClassSelection(
    domain: Domain,
    label: AnyLabel,
    samples: readonly Sample[],
    cacheEntries: readonly SimilarityCacheEntry[],
  ): Promise<void>;

  getActiveIndex(): Promise<ActiveIndex | undefined>;
  setActiveIndex(index: ActiveIndex): Promise<void>;
  clearActiveIndex(): Promise<void>;

  getSimilarityCache(domain: Domain, label: AnyLabel): Promise<SimilarityCacheEntry[]>;
  setSimilarityCache(
    domain: Domain,
    label: AnyLabel,
    entries: readonly SimilarityCacheEntry[],
  ): Promise<void>;
  clearSimilarityCache(domain: Domain, label: AnyLabel): Promise<void>;

  /** Dataset互換性喪失時に消す派生/学習データ。meta（installationId/settings）は維持する。 */
  clearDatasetState(): Promise<void>;
  /** 完全初期化。metaを含む全storeを空にする。 */
  resetAll(): Promise<void>;
}

const INDEX_DOMAIN_LABEL = 'domainLabel';
const INDEX_SOURCE_INSTALLATION = 'sourceInstallationId';
const ACTIVE_INDEX_KEY = 'current';
const DATA_REVISION_KEY = 'dataRevision';
const LEGACY_STORE = 'datasets';

export function createIndexedDbDatabase(): DatabasePort {
  return new IndexedDbDatabase();
}

class IndexedDbDatabase implements DatabasePort {
  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.meta, 'readonly');
      const done = transactionDone(tx);
      const value = await requestToPromise<T | undefined>(tx.objectStore(STORE_NAMES.meta).get(key));
      await done;
      return value;
    });
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.meta, 'readwrite');
      tx.objectStore(STORE_NAMES.meta).put(value, key);
      await transactionDone(tx);
    });
  }

  async deleteMeta(key: string): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.meta, 'readwrite');
      tx.objectStore(STORE_NAMES.meta).delete(key);
      await transactionDone(tx);
    });
  }

  async getSamples(storeName: SampleStoreName, filter: SampleFilter = {}): Promise<Sample[]> {
    return this.withDatabase(async (db) => {
      const tx = db.transaction(storeName, 'readonly');
      const done = transactionDone(tx);
      const store = tx.objectStore(storeName);
      let request: IDBRequest<Sample[]>;

      if (filter.domain && filter.label) {
        request = store.index(INDEX_DOMAIN_LABEL).getAll(IDBKeyRange.only([filter.domain, filter.label]));
      } else if (filter.sourceInstallationId) {
        request = store.index(INDEX_SOURCE_INSTALLATION).getAll(filter.sourceInstallationId);
      } else {
        request = store.getAll();
      }

      let samples = await requestToPromise(request);
      await done;

      if (filter.domain && !filter.label) samples = samples.filter((sample) => sample.domain === filter.domain);
      if (filter.label && !filter.domain) samples = samples.filter((sample) => sample.label === filter.label);
      if (filter.sourceInstallationId && filter.domain && filter.label) {
        samples = samples.filter((sample) => sample.sourceInstallationId === filter.sourceInstallationId);
      }
      return samples;
    });
  }

  async putSamples(storeName: SampleStoreName, samples: readonly Sample[]): Promise<void> {
    if (samples.length === 0) return;
    await this.withDatabase(async (db) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const sample of samples) store.put(sample);
      await transactionDone(tx);
    });
  }

  async clearSampleStore(storeName: SampleStoreName): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      await transactionDone(tx);
    });
  }

  async replaceImportedSource(
    sourceInstallationId: string,
    samples: readonly Sample[],
    nextDataRevision?: number,
  ): Promise<void> {
    if (nextDataRevision !== undefined && (!Number.isInteger(nextDataRevision) || nextDataRevision < 0)) {
      throw new Error('nextDataRevision must be a non-negative integer');
    }

    await this.withDatabase(async (db) => {
      const stores =
        nextDataRevision === undefined
          ? [STORE_NAMES.importedSamples]
          : [STORE_NAMES.importedSamples, STORE_NAMES.meta];
      const tx = db.transaction(stores, 'readwrite');
      const store = tx.objectStore(STORE_NAMES.importedSamples);
      const index = store.index(INDEX_SOURCE_INSTALLATION);
      const cursorRequest = index.openKeyCursor(IDBKeyRange.only(sourceInstallationId));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }
        for (const sample of samples) store.put(sample);
        if (nextDataRevision !== undefined) {
          tx.objectStore(STORE_NAMES.meta).put(nextDataRevision, DATA_REVISION_KEY);
        }
      };

      await transactionDone(tx);
    });
  }

  async commitLocalClassSelection(
    domain: Domain,
    label: AnyLabel,
    samples: readonly Sample[],
    cacheEntries: readonly SimilarityCacheEntry[],
  ): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction([STORE_NAMES.localSamples, STORE_NAMES.similarityCache], 'readwrite');
      const sampleStore = tx.objectStore(STORE_NAMES.localSamples);
      const cacheStore = tx.objectStore(STORE_NAMES.similarityCache);
      const cursorRequest = sampleStore
        .index(INDEX_DOMAIN_LABEL)
        .openKeyCursor(IDBKeyRange.only([domain, label]));

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          sampleStore.delete(cursor.primaryKey);
          cursor.continue();
          return;
        }

        for (const sample of samples) sampleStore.put(sample);
        cacheStore.put([...cacheEntries], similarityCacheKey(domain, label));
      };

      await transactionDone(tx);
    });
  }

  async getActiveIndex(): Promise<ActiveIndex | undefined> {
    return this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.activeIndex, 'readonly');
      const done = transactionDone(tx);
      const value = await requestToPromise<ActiveIndex | undefined>(
        tx.objectStore(STORE_NAMES.activeIndex).get(ACTIVE_INDEX_KEY),
      );
      await done;
      return value;
    });
  }

  async setActiveIndex(index: ActiveIndex): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.activeIndex, 'readwrite');
      tx.objectStore(STORE_NAMES.activeIndex).put(index, ACTIVE_INDEX_KEY);
      await transactionDone(tx);
    });
  }

  async clearActiveIndex(): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.activeIndex, 'readwrite');
      tx.objectStore(STORE_NAMES.activeIndex).clear();
      await transactionDone(tx);
    });
  }

  async getSimilarityCache(domain: Domain, label: AnyLabel): Promise<SimilarityCacheEntry[]> {
    return this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.similarityCache, 'readonly');
      const done = transactionDone(tx);
      const entries = await requestToPromise<SimilarityCacheEntry[] | undefined>(
        tx.objectStore(STORE_NAMES.similarityCache).get(similarityCacheKey(domain, label)),
      );
      await done;
      return entries ?? [];
    });
  }

  async setSimilarityCache(
    domain: Domain,
    label: AnyLabel,
    entries: readonly SimilarityCacheEntry[],
  ): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.similarityCache, 'readwrite');
      tx.objectStore(STORE_NAMES.similarityCache).put([...entries], similarityCacheKey(domain, label));
      await transactionDone(tx);
    });
  }

  async clearSimilarityCache(domain: Domain, label: AnyLabel): Promise<void> {
    await this.withDatabase(async (db) => {
      const tx = db.transaction(STORE_NAMES.similarityCache, 'readwrite');
      tx.objectStore(STORE_NAMES.similarityCache).delete(similarityCacheKey(domain, label));
      await transactionDone(tx);
    });
  }

  async clearDatasetState(): Promise<void> {
    const stores = [
      STORE_NAMES.localSamples,
      STORE_NAMES.importedSamples,
      STORE_NAMES.activeIndex,
      STORE_NAMES.similarityCache,
      STORE_NAMES.validationSessions,
    ];
    await this.withDatabase(async (db) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) tx.objectStore(store).clear();
      await transactionDone(tx);
    });
  }

  async resetAll(): Promise<void> {
    const stores = Object.values(STORE_NAMES);
    await this.withDatabase(async (db) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) tx.objectStore(store).clear();
      await transactionDone(tx);
    });
  }

  private async withDatabase<T>(action: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openDatabase();
    try {
      return await action(db);
    } finally {
      db.close();
    }
  }
}

function similarityCacheKey(domain: Domain, label: AnyLabel): string {
  return `${domain}:${label}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(LEGACY_STORE)) db.deleteObjectStore(LEGACY_STORE);

      if (!db.objectStoreNames.contains(STORE_NAMES.meta)) db.createObjectStore(STORE_NAMES.meta);
      createSampleStoreIfMissing(db, STORE_NAMES.localSamples);
      createSampleStoreIfMissing(db, STORE_NAMES.importedSamples);
      if (!db.objectStoreNames.contains(STORE_NAMES.activeIndex)) db.createObjectStore(STORE_NAMES.activeIndex);
      if (!db.objectStoreNames.contains(STORE_NAMES.similarityCache)) db.createObjectStore(STORE_NAMES.similarityCache);
      if (!db.objectStoreNames.contains(STORE_NAMES.validationSessions)) {
        db.createObjectStore(STORE_NAMES.validationSessions, { keyPath: 'validationSessionId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDBを開けませんでした'));
    request.onblocked = () => reject(new Error('IndexedDBのschema更新が他タブによりブロックされています'));
  });
}

function createSampleStoreIfMissing(db: IDBDatabase, name: SampleStoreName): void {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, { keyPath: ['sourceInstallationId', 'id'] });
  store.createIndex(INDEX_DOMAIN_LABEL, ['domain', 'label'], { unique: false });
  store.createIndex(INDEX_SOURCE_INSTALLATION, 'sourceInstallationId', { unique: false });
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
