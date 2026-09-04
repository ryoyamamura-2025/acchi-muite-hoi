import { describe, expect, it } from 'vitest';
import {
  ActiveDatasetRepository,
  canPlayWithActiveDataset,
  createEmptyActiveIndex,
  getMissingTrainingClasses,
  rebuildActiveDataset,
} from '../src/data/activeDataset';
import { DatasetRepository } from '../src/data/datasetRepository';
import type { FaceLabel, PointerLabel } from '../src/ml/labels';
import type { Sample } from '../src/ml/types';
import { makeSampleKey } from '../src/ml/types';
import { MemoryDatabase } from './helpers/memoryDatabase';

function sample(
  sourceInstallationId: string,
  id: string,
  domain: 'pointer' | 'face',
  label: PointerLabel | FaceLabel,
  feature: Float32Array,
  capturedAt = 1,
): Sample {
  return {
    sourceInstallationId,
    id,
    domain,
    label,
    feature,
    capturedAt,
    captureSessionId: 'session',
  } as Sample;
}

describe('Active Dataset', () => {
  it('Shared OFFではLocalのみ、ONではImportedも候補にする', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const active = new ActiveDatasetRepository(db);

    const local = sample('z-local', 'local-up', 'pointer', 'up', new Float32Array([1, 0]));
    const imported = sample(
      'a-imported',
      'imported-up',
      'pointer',
      'up',
      new Float32Array([0, 1]),
    );
    await datasets.commitLocalSamples([local], 'z-local');
    await datasets.commitImportedSamples([imported]);

    const off = await rebuildActiveDataset(datasets, active, false);
    expect(off.pointer.up).toEqual([makeSampleKey('z-local', 'local-up')]);

    const on = await rebuildActiveDataset(datasets, active, true);
    expect(on.pointer.up).toHaveLength(2);
    expect(on.pointer.up).toContain(makeSampleKey('z-local', 'local-up'));
    expect(on.pointer.up).toContain(makeSampleKey('a-imported', 'imported-up'));
    expect(on.revision).toBe(off.revision + 1);
  });

  it('重複候補でLocalを優先せずsample key順で対等に選ぶ', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const active = new ActiveDatasetRepository(db);

    const local = sample('z-local', 'same-pose', 'pointer', 'up', new Float32Array([1, 0]));
    const imported = sample(
      'a-imported',
      'same-pose',
      'pointer',
      'up',
      new Float32Array([1, 0]),
    );
    await datasets.commitLocalSamples([local], 'z-local');
    await datasets.commitImportedSamples([imported]);

    const index = await rebuildActiveDataset(datasets, active, true);
    expect(index.pointer.up).toEqual([makeSampleKey('a-imported', 'same-pose')]);
  });

  it('各classのActiveを最大100件に制限する', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const active = new ActiveDatasetRepository(db);
    const samples: Sample[] = [];

    for (let i = 0; i < 101; i += 1) {
      const feature = new Float32Array(101);
      feature[i] = 1;
      samples.push(sample('local', `s-${i.toString().padStart(3, '0')}`, 'pointer', 'up', feature, i));
    }
    await datasets.commitLocalSamples(samples, 'local');

    const index = await rebuildActiveDataset(datasets, active, false);
    expect(index.pointer.up).toHaveLength(100);
  });

  it('Pointer/Face全classがActive 10件以上ならcanPlayになる', () => {
    const index = createEmptyActiveIndex(1);
    const pointerLabels: PointerLabel[] = ['up', 'right', 'down', 'left', 'neutral'];
    const faceLabels: FaceLabel[] = ['up', 'right', 'down', 'left', 'front'];

    for (const label of pointerLabels) {
      index.pointer[label] = Array.from({ length: 10 }, (_, i) => `pointer:${label}:${i}`);
    }
    for (const label of faceLabels) {
      index.face[label] = Array.from({ length: 10 }, (_, i) => `face:${label}:${i}`);
    }

    expect(canPlayWithActiveDataset(index)).toBe(true);
    expect(getMissingTrainingClasses(index)).toEqual({ pointer: [], face: [] });

    index.face.front.pop();
    expect(canPlayWithActiveDataset(index)).toBe(false);
    expect(getMissingTrainingClasses(index).face).toEqual(['front']);
  });
});
