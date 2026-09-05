import { describe, expect, it } from 'vitest';
import {
  DataApplicationService,
  type DatasetModelController,
} from '../src/app/dataApplicationService';
import {
  createEmptyActiveIndex,
  type MissingTrainingClasses,
} from '../src/data/activeDataset';
import { DatasetRepository } from '../src/data/datasetRepository';
import type { ModelServiceStatus } from '../src/app/modelService';
import type { ActiveIndex, Sample } from '../src/ml/types';
import { makeSampleKey } from '../src/ml/types';
import { MemoryDatabase } from './helpers/memoryDatabase';

function sample(
  id: string,
  sourceInstallationId: string,
  domain: 'pointer' | 'face',
  label: 'up' | 'front',
): Sample {
  return {
    id,
    domain,
    label,
    feature: new Float32Array([1, 0]),
    capturedAt: 1,
    captureSessionId: 'session',
    sourceInstallationId,
  } as Sample;
}

class FakeModel implements DatasetModelController {
  refreshCount = 0;
  status: ModelServiceStatus = {
    state: 'ready',
    sharedDataEnabled: true,
    activeDatasetRevision: 1,
    errorMessage: null,
  };
  active: ActiveIndex = createEmptyActiveIndex(1);

  getStatus(): ModelServiceStatus {
    return { ...this.status };
  }

  getActiveIndex(): ActiveIndex {
    return structuredClone(this.active);
  }

  getMissingTrainingClasses(): MissingTrainingClasses {
    return {
      pointer: ['right', 'down', 'left', 'neutral'],
      face: ['up', 'right', 'down', 'left', 'front'],
    };
  }

  async refreshFromDatasets(): Promise<void> {
    this.refreshCount += 1;
  }
}

describe('DataApplicationService', () => {
  it('Local / Imported / Active件数をUI向けに集約する', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const model = new FakeModel();
    const local = sample('local-up', 'self', 'pointer', 'up');
    const imported = sample('imported-front', 'other', 'face', 'front');
    await datasets.commitLocalSamples([local], 'self');
    await datasets.commitImportedSamples([imported]);
    model.active.pointer.up = [makeSampleKey(local.sourceInstallationId, local.id)];

    const service = new DataApplicationService(db, model);
    const summary = await service.getDatasetSummary();

    expect(summary.pointer.up).toEqual({ active: 1, local: 1, imported: 0, ready: true });
    expect(summary.face.front.imported).toBe(1);
    expect(summary.totals).toEqual({ active: 1, local: 1, imported: 1 });
  });

  it('Local / Importedを別々に削除してClassifier再構築を要求する', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const model = new FakeModel();
    await datasets.commitLocalSamples([sample('local-up', 'self', 'pointer', 'up')], 'self');
    await datasets.commitImportedSamples([sample('imported-front', 'other', 'face', 'front')]);
    const service = new DataApplicationService(db, model);

    await service.clearLocalDataset();
    expect(await datasets.getLocalSamples()).toHaveLength(0);
    expect(await datasets.getImportedSamples()).toHaveLength(1);
    expect(model.refreshCount).toBe(1);

    await service.clearImportedDataset();
    expect(await datasets.getImportedSamples()).toHaveLength(0);
    expect(model.refreshCount).toBe(2);
  });

  it('完全初期化でmetaを含む永続状態を消す', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const model = new FakeModel();
    await db.setMeta('installationId', 'self');
    await datasets.commitLocalSamples([sample('local-up', 'self', 'pointer', 'up')], 'self');
    const service = new DataApplicationService(db, model);

    await service.resetApplication();

    expect(await db.getMeta('installationId')).toBeUndefined();
    expect(await datasets.getLocalSamples()).toHaveLength(0);
  });
});
