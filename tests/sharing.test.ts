import { describe, expect, it } from 'vitest';
import { DatasetRepository } from '../src/data/datasetRepository';
import { DATASET_VERSION } from '../src/data/installation';
import type { FaceLabel, PointerLabel } from '../src/ml/labels';
import type { Sample } from '../src/ml/types';
import { exportLocalDataset } from '../src/sharing/exportDataset';
import { importDatasetArchive } from '../src/sharing/importDataset';
import { MANIFEST_FILE, POINTER_BINARY_FILE } from '../src/sharing/manifest';
import { readStoredZip, writeStoredZip } from '../src/sharing/zip';
import { MemoryDatabase } from './helpers/memoryDatabase';

const EXTRACTOR = 'test-extractor';
const FEATURE_DIM = 2;

function sample(
  sourceInstallationId: string,
  id: string,
  domain: 'pointer' | 'face',
  label: PointerLabel | FaceLabel,
  feature: [number, number] = [1, 0],
): Sample {
  return {
    id,
    domain,
    label,
    feature: new Float32Array(feature),
    capturedAt: 100,
    captureSessionId: `session-${sourceInstallationId}`,
    sourceInstallationId,
  } as Sample;
}

async function archiveFor(
  sourceInstallationId: string,
  samples: readonly Sample[],
): Promise<Uint8Array> {
  const db = new MemoryDatabase();
  const repo = new DatasetRepository(db);
  await repo.commitLocalSamples(samples, sourceInstallationId);
  return (
    await exportLocalDataset({
      datasetRepository: repo,
      installationId: sourceInstallationId,
      datasetVersion: DATASET_VERSION,
      extractorName: EXTRACTOR,
      featureDim: FEATURE_DIM,
      exportedAt: new Date('2026-09-05T00:00:00.000Z'),
    })
  ).bytes;
}

async function importInto(
  db: MemoryDatabase,
  bytes: Uint8Array,
  overrides: Partial<{ datasetVersion: number; extractorName: string; featureDim: number }> = {},
) {
  return importDatasetArchive({
    bytes,
    datasetRepository: new DatasetRepository(db),
    compatibility: {
      datasetVersion: overrides.datasetVersion ?? DATASET_VERSION,
      extractorName: overrides.extractorName ?? EXTRACTOR,
      featureDim: overrides.featureDim ?? FEATURE_DIM,
    },
    currentDataRevision: (await db.getMeta<number>('dataRevision')) ?? 0,
  });
}

describe('Phase 5 Dataset sharing', () => {
  it('ExportはLocal Datasetだけを3-file ZIPへ書き出す', async () => {
    const db = new MemoryDatabase();
    const repo = new DatasetRepository(db);
    await repo.commitLocalSamples(
      [
        sample('local-installation', 'p-up', 'pointer', 'up', [1, 0]),
        sample('local-installation', 'f-front', 'face', 'front', [0, 1]),
      ],
      'local-installation',
    );
    await repo.commitImportedSamples([
      sample('other-installation', 'imported', 'pointer', 'up', [0, 1]),
    ]);

    const exported = await exportLocalDataset({
      datasetRepository: repo,
      installationId: 'local-installation',
      datasetVersion: DATASET_VERSION,
      extractorName: EXTRACTOR,
      featureDim: FEATURE_DIM,
      exportedAt: new Date('2026-09-05T00:00:00.000Z'),
    });

    const files = readStoredZip(exported.bytes);
    expect([...files.keys()].sort()).toEqual(['face.bin', 'manifest.json', 'pointer.bin']);
    const manifest = JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE)!));
    expect(manifest.installationId).toBe('local-installation');
    expect(manifest.samples).toHaveLength(2);
    expect(manifest.samples.every((item: { sourceInstallationId: string }) => item.sourceInstallationId === 'local-installation')).toBe(true);
    expect(exported.sampleCount).toBe(2);
  });

  it('Export→ImportでFloat32特徴量とmetadataを復元しdataRevisionを更新する', async () => {
    const bytes = await archiveFor('source-a', [
      sample('source-a', 'p-up', 'pointer', 'up', [0.25, -0.5]),
      sample('source-a', 'f-front', 'face', 'front', [0.75, 0.125]),
    ]);
    const destination = new MemoryDatabase();
    await destination.setMeta('dataRevision', 7);

    const result = await importInto(destination, bytes);
    expect(result).toMatchObject({
      kind: 'success',
      sourceInstallationId: 'source-a',
      importedSampleCount: 2,
      replacedSampleCount: 0,
      dataRevision: 8,
    });

    const imported = await new DatasetRepository(destination).getImportedSamples();
    expect(imported).toHaveLength(2);
    expect([...imported.find((item) => item.id === 'p-up')!.feature]).toEqual([0.25, -0.5]);
    expect(await destination.getMeta('dataRevision')).toBe(8);
  });

  it('checksum不一致ではImportを拒否し、同sourceの既存データを残す', async () => {
    const bytes = await archiveFor('source-a', [sample('source-a', 'new', 'pointer', 'up')]);
    const files = readStoredZip(bytes);
    const pointer = new Uint8Array(files.get(POINTER_BINARY_FILE)!);
    pointer[0] ^= 0xff;
    files.set(POINTER_BINARY_FILE, pointer);
    const corrupted = writeStoredZip([...files].map(([name, data]) => ({ name, data })));

    const destination = new MemoryDatabase();
    const repo = new DatasetRepository(destination);
    await repo.commitImportedSamples([sample('source-a', 'old', 'pointer', 'up', [0, 1])]);

    const result = await importInto(destination, corrupted);
    expect(result).toMatchObject({ kind: 'error', code: 'checksum-mismatch' });
    const after = await repo.getImportedSamples({ sourceInstallationId: 'source-a' });
    expect(after.map((item) => item.id)).toEqual(['old']);
  });

  it('Dataset version不一致とExtractor不一致を別エラーにする', async () => {
    const bytes = await archiveFor('source-a', [sample('source-a', 's', 'pointer', 'up')]);

    const versionResult = await importInto(new MemoryDatabase(), bytes, { datasetVersion: 999 });
    expect(versionResult).toMatchObject({ kind: 'error', code: 'dataset-version-mismatch' });

    const extractorResult = await importInto(new MemoryDatabase(), bytes, {
      extractorName: 'different-extractor',
    });
    expect(extractorResult).toMatchObject({ kind: 'error', code: 'extractor-incompatible' });
  });

  it('1 source / domain / classが100件を超えるファイルを全体拒否する', async () => {
    const samples = Array.from({ length: 101 }, (_, index) =>
      sample('source-a', `s-${index}`, 'pointer', 'up', [1, index / 1000]),
    );
    const bytes = await archiveFor('source-a', samples);
    const destination = new MemoryDatabase();

    const result = await importInto(destination, bytes);
    expect(result).toMatchObject({ kind: 'error', code: 'limit-exceeded' });
    expect(await new DatasetRepository(destination).getImportedSamples()).toHaveLength(0);
  });

  it('同source再Importは旧source分を引いた最終状態で500件上限を判定して置換する', async () => {
    const destination = new MemoryDatabase();
    const repo = new DatasetRepository(destination);
    const existing: Sample[] = [];
    for (let source = 0; source < 5; source += 1) {
      const sourceId = source === 0 ? 'source-a' : `other-${source}`;
      for (let i = 0; i < 100; i += 1) {
        existing.push(sample(sourceId, `${sourceId}-${i}`, 'pointer', 'up', [1, i / 1000]));
      }
    }
    await repo.commitImportedSamples(existing);
    await destination.setMeta('dataRevision', 10);

    const replacement = Array.from({ length: 100 }, (_, index) =>
      sample('source-a', `replacement-${index}`, 'pointer', 'up', [0, 1 + index / 1000]),
    );
    const bytes = await archiveFor('source-a', replacement);
    const result = await importInto(destination, bytes);

    expect(result).toMatchObject({
      kind: 'success',
      importedSampleCount: 100,
      replacedSampleCount: 100,
      dataRevision: 11,
    });
    expect(await repo.getImportedSamples({ domain: 'pointer', label: 'up' })).toHaveLength(500);
    expect(await repo.getImportedSamples({ sourceInstallationId: 'source-a' })).toHaveLength(100);
  });

  it('最終Importedがclass 500件を超える場合は全体拒否する', async () => {
    const destination = new MemoryDatabase();
    const repo = new DatasetRepository(destination);
    const existing: Sample[] = [];
    for (let source = 0; source < 5; source += 1) {
      for (let i = 0; i < 100; i += 1) {
        existing.push(sample(`other-${source}`, `o-${source}-${i}`, 'pointer', 'up'));
      }
    }
    await repo.commitImportedSamples(existing);

    const bytes = await archiveFor('new-source', [
      sample('new-source', 'one-more', 'pointer', 'up', [0, 1]),
    ]);
    const result = await importInto(destination, bytes);

    expect(result).toMatchObject({ kind: 'error', code: 'limit-exceeded' });
    expect(await repo.getImportedSamples()).toHaveLength(500);
  });
});
