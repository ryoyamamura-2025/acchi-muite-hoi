import type { InstallationId } from '../ml/types';
import type { DatabasePort } from './database';

export const DATASET_VERSION = 1;

export const META_KEYS = {
  installationId: 'installationId',
  datasetVersion: 'datasetVersion',
  extractorName: 'extractorName',
  featureDim: 'featureDim',
  sharedDataEnabled: 'sharedDataEnabled',
  settings: 'settings',
  /** Local / Imported実データの変更世代。 */
  dataRevision: 'dataRevision',
  /** 現在のActive IndexがどのdataRevisionから作られたか。 */
  activeSourceRevision: 'activeSourceRevision',
  /** 現在のActive Indexを作ったときのShared設定。 */
  activeSharedDataEnabled: 'activeSharedDataEnabled',
} as const;

export interface DatasetCompatibility {
  datasetVersion: number;
  extractorName: string;
  featureDim: number;
}

export type CompatibilityResult = 'initialized' | 'compatible' | 'reset';

export async function getOrCreateInstallationId(db: DatabasePort): Promise<InstallationId> {
  const existing = await db.getMeta<InstallationId>(META_KEYS.installationId);
  if (existing) return existing;

  const installationId = createId();
  await db.setMeta(META_KEYS.installationId, installationId);
  return installationId;
}

export async function getDataRevision(db: DatabasePort): Promise<number> {
  const value = await db.getMeta<number>(META_KEYS.dataRevision);
  return Number.isInteger(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

/**
 * extractor / feature dimension / dataset versionが変わった場合、旧特徴空間のデータを破棄する。
 * installationIdと一般settingsは維持する。
 */
export async function ensureDatasetCompatibility(
  db: DatabasePort,
  expected: DatasetCompatibility,
): Promise<CompatibilityResult> {
  const [datasetVersion, extractorName, featureDim] = await Promise.all([
    db.getMeta<number>(META_KEYS.datasetVersion),
    db.getMeta<string>(META_KEYS.extractorName),
    db.getMeta<number>(META_KEYS.featureDim),
  ]);

  const hasAnyCompatibilityMeta =
    datasetVersion !== undefined || extractorName !== undefined || featureDim !== undefined;
  const compatible =
    datasetVersion === expected.datasetVersion &&
    extractorName === expected.extractorName &&
    featureDim === expected.featureDim;

  if (compatible) {
    if ((await db.getMeta<number>(META_KEYS.dataRevision)) === undefined) {
      await db.setMeta(META_KEYS.dataRevision, 0);
    }
    return 'compatible';
  }

  if (hasAnyCompatibilityMeta) await db.clearDatasetState();

  await Promise.all([
    db.setMeta(META_KEYS.datasetVersion, expected.datasetVersion),
    db.setMeta(META_KEYS.extractorName, expected.extractorName),
    db.setMeta(META_KEYS.featureDim, expected.featureDim),
    db.setMeta(META_KEYS.dataRevision, 0),
    db.deleteMeta(META_KEYS.activeSourceRevision),
    db.deleteMeta(META_KEYS.activeSharedDataEnabled),
  ]);

  return hasAnyCompatibilityMeta ? 'reset' : 'initialized';
}

export async function resetApplication(db: DatabasePort): Promise<void> {
  await db.resetAll();
}

function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
