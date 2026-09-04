import * as tf from '@tensorflow/tfjs';
import { isClassLabel } from './labels';

const DB_NAME = 'acchi-muite-hoi';
const DB_VERSION = 1;
const STORE = 'datasets';
const KEY = 'knn-dataset';

interface StoredClass {
  data: Float32Array;
  count: number;
}

interface StoredDataset {
  /** 特徴抽出器が変わったら過去の学習データは無意味なので捨てる。 */
  extractor: string;
  featureDim: number;
  classes: Record<string, StoredClass>;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveDataset(
  dataset: Record<string, tf.Tensor2D>,
  extractor: string,
  featureDim: number,
): Promise<void> {
  const classes: Record<string, StoredClass> = {};
  for (const [label, tensor] of Object.entries(dataset)) {
    classes[label] = {
      data: tensor.dataSync() as Float32Array,
      count: tensor.shape[0],
    };
  }

  const payload: StoredDataset = { extractor, featureDim, classes, savedAt: Date.now() };
  const db = await openDb();
  try {
    await runTransaction(db, 'readwrite', (store) => store.put(payload, KEY));
  } finally {
    db.close();
  }
}

/**
 * 保存済みの学習データを復元する。
 * 見つからない / 特徴抽出器が違う / 壊れている場合は `null`（学習し直してもらう）。
 */
export async function loadDataset(
  extractor: string,
  featureDim: number,
): Promise<Record<string, tf.Tensor2D> | null> {
  let stored: StoredDataset | undefined;
  const db = await openDb();
  try {
    stored = await runTransaction<StoredDataset | undefined>(db, 'readonly', (store) =>
      store.get(KEY),
    );
  } finally {
    db.close();
  }

  if (!stored || stored.extractor !== extractor || stored.featureDim !== featureDim) return null;

  const dataset: Record<string, tf.Tensor2D> = {};
  try {
    for (const [label, entry] of Object.entries(stored.classes)) {
      if (!isClassLabel(label)) continue;
      if (entry.data.length !== entry.count * featureDim) continue;
      dataset[label] = tf.tensor2d(entry.data, [entry.count, featureDim]);
    }
  } catch (error) {
    console.warn('保存済みの学習データを復元できませんでした', error);
    Object.values(dataset).forEach((tensor) => tensor.dispose());
    return null;
  }

  return Object.keys(dataset).length > 0 ? dataset : null;
}

export async function clearDataset(): Promise<void> {
  const db = await openDb();
  try {
    await runTransaction(db, 'readwrite', (store) => store.delete(KEY));
  } finally {
    db.close();
  }
}
