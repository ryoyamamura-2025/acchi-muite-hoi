import { describe, expect, it } from 'vitest';
import { ActiveDatasetRepository, createEmptyActiveIndex } from '../src/data/activeDataset';
import { DatasetRepository } from '../src/data/datasetRepository';
import {
  ensureDatasetCompatibility,
  getOrCreateInstallationId,
  resetApplication,
} from '../src/data/installation';
import { FACE_LABELS, POINTER_LABELS } from '../src/ml/labels';
import type { Sample } from '../src/ml/types';
import { makeSampleKey } from '../src/ml/types';
import { MemoryDatabase } from './helpers/memoryDatabase';

function pointerSample(overrides: Partial<Sample> = {}): Sample {
  return {
    id: 'sample-1',
    domain: 'pointer',
    label: 'up',
    feature: new Float32Array([1, 2, 3]),
    capturedAt: 100,
    captureSessionId: 'session-1',
    sourceInstallationId: 'installation-a',
    ...overrides,
  } as Sample;
}

describe('Phase 1 labels', () => {
  it('Pointer / Faceを別ラベル体系として定義する', () => {
    expect(POINTER_LABELS).toEqual(['up', 'right', 'down', 'left', 'neutral']);
    expect(FACE_LABELS).toEqual(['up', 'right', 'down', 'left', 'front']);
  });
});

describe('DatasetRepository', () => {
  it('Local / Importedを分離して保存・復元できる', async () => {
    const db = new MemoryDatabase();
    const repository = new DatasetRepository(db);
    const local = pointerSample();
    const imported = pointerSample({ sourceInstallationId: 'installation-b' });

    await repository.commitLocalSamples([local], 'installation-a');
    await repository.commitImportedSamples([imported]);

    expect(await repository.getLocalSamples()).toHaveLength(1);
    expect((await repository.getLocalSamples())[0].sourceInstallationId).toBe('installation-a');
    expect(await repository.getImportedSamples()).toHaveLength(1);
    expect((await repository.getImportedSamples())[0].sourceInstallationId).toBe('installation-b');
  });

  it('同じsample idでもsourceInstallationIdが違えば衝突しない', async () => {
    const db = new MemoryDatabase();
    const repository = new DatasetRepository(db);
    await repository.commitImportedSamples([
      pointerSample({ sourceInstallationId: 'installation-a' }),
      pointerSample({ sourceInstallationId: 'installation-b' }),
    ]);

    expect(await repository.getImportedSamples()).toHaveLength(2);
    expect(makeSampleKey('installation-a', 'sample-1')).not.toBe(
      makeSampleKey('installation-b', 'sample-1'),
    );
  });

  it('same source置換では他sourceを維持する', async () => {
    const db = new MemoryDatabase();
    const repository = new DatasetRepository(db);
    await repository.commitImportedSamples([
      pointerSample({ sourceInstallationId: 'installation-a' }),
      pointerSample({ id: 'b-1', sourceInstallationId: 'installation-b' }),
    ]);

    await repository.replaceImportedSource('installation-a', [
      pointerSample({ id: 'a-new', sourceInstallationId: 'installation-a', label: 'right' }),
    ]);

    const all = await repository.getImportedSamples();
    expect(all).toHaveLength(2);
    expect(all.some((sample) => sample.id === 'sample-1')).toBe(false);
    expect(all.some((sample) => sample.id === 'a-new')).toBe(true);
    expect(all.some((sample) => sample.id === 'b-1')).toBe(true);
  });
});

describe('installationId / compatibility', () => {
  it('Local Dataset削除ではinstallationIdを維持する', async () => {
    const db = new MemoryDatabase();
    const repository = new DatasetRepository(db);
    const installationId = await getOrCreateInstallationId(db);
    await repository.commitLocalSamples(
      [pointerSample({ sourceInstallationId: installationId })],
      installationId,
    );

    await repository.clearLocalDataset();

    expect(await getOrCreateInstallationId(db)).toBe(installationId);
    expect(await repository.getLocalSamples()).toHaveLength(0);
  });

  it('完全初期化ではinstallationIdも再発行する', async () => {
    const db = new MemoryDatabase();
    const before = await getOrCreateInstallationId(db);
    await resetApplication(db);
    const after = await getOrCreateInstallationId(db);

    expect(after).not.toBe(before);
  });

  it('互換性不一致ではDataset/Activeを消しinstallationIdは維持する', async () => {
    const db = new MemoryDatabase();
    const repository = new DatasetRepository(db);
    const active = new ActiveDatasetRepository(db);
    const installationId = await getOrCreateInstallationId(db);

    expect(
      await ensureDatasetCompatibility(db, {
        datasetVersion: 1,
        extractorName: 'extractor-a',
        featureDim: 3,
      }),
    ).toBe('initialized');

    await repository.commitLocalSamples(
      [pointerSample({ sourceInstallationId: installationId })],
      installationId,
    );
    const index = createEmptyActiveIndex(7);
    index.pointer.up.push(makeSampleKey(installationId, 'sample-1'));
    await active.save(index);

    expect(
      await ensureDatasetCompatibility(db, {
        datasetVersion: 1,
        extractorName: 'extractor-b',
        featureDim: 3,
      }),
    ).toBe('reset');

    expect(await repository.getLocalSamples()).toHaveLength(0);
    expect((await active.load()).revision).toBe(0);
    expect(await getOrCreateInstallationId(db)).toBe(installationId);
  });
});

describe('ActiveDatasetRepository', () => {
  it('Active Indexを保存・復元する', async () => {
    const db = new MemoryDatabase();
    const firstRepository = new ActiveDatasetRepository(db);
    const index = createEmptyActiveIndex(3);
    index.pointer.up.push('source-a:sample-1');
    index.face.front.push('source-b:sample-2');
    await firstRepository.save(index);

    const restored = await new ActiveDatasetRepository(db).load();
    expect(restored).toEqual(index);
  });
});
