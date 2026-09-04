import type { Tensor2D } from '@tensorflow/tfjs';
import { describe, expect, it } from 'vitest';
import { ModelService } from '../src/app/modelService';
import { DatasetRepository } from '../src/data/datasetRepository';
import { META_KEYS } from '../src/data/installation';
import type {
  DomainClassifier,
  DomainPrediction,
} from '../src/ml/classifier';
import type { FeatureExtractor } from '../src/ml/featureExtractor';
import type { FaceLabel, PointerLabel } from '../src/ml/labels';
import type { Sample } from '../src/ml/types';
import { MemoryDatabase } from './helpers/memoryDatabase';

class FakeClassifier<L extends string> implements DomainClassifier<L> {
  rebuiltWith: Sample[] = [];

  constructor(private readonly labels: readonly L[]) {}

  rebuild(samples: readonly Sample[]): void {
    this.rebuiltWith = [...samples];
  }

  async predict(_feature: Tensor2D): Promise<DomainPrediction<L> | null> {
    return null;
  }

  counts(): Record<L, number> {
    const counts = Object.fromEntries(this.labels.map((label) => [label, 0])) as Record<L, number>;
    for (const sample of this.rebuiltWith) {
      if (this.labels.includes(sample.label as L)) counts[sample.label as L] += 1;
    }
    return counts;
  }

  total(): number {
    return this.rebuiltWith.length;
  }

  dispose(): void {}
}

function importedSample(
  id: string,
  domain: 'pointer' | 'face',
  label: PointerLabel | FaceLabel,
  featureIndex: number,
  featureDim: number,
): Sample {
  const feature = new Float32Array(featureDim);
  feature[featureIndex] = 1;
  return {
    id,
    domain,
    label,
    feature,
    capturedAt: featureIndex,
    captureSessionId: 'imported-session',
    sourceInstallationId: 'other-installation',
  } as Sample;
}

function fakeExtractor(featureDim: number): FeatureExtractor {
  return {
    name: 'test-extractor',
    featureDim,
    infer() {
      throw new Error('infer should not be called in this test');
    },
    dispose() {},
  };
}

describe('ModelService Phase 4', () => {
  it('Imported DatasetだけでもShared ONなら両KNNを再構築してcanPlayになる', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const pointerLabels: PointerLabel[] = ['up', 'right', 'down', 'left', 'neutral'];
    const faceLabels: FaceLabel[] = ['up', 'right', 'down', 'left', 'front'];
    const featureDim = 100;
    const samples: Sample[] = [];
    let featureIndex = 0;

    for (const label of pointerLabels) {
      for (let i = 0; i < 10; i += 1) {
        samples.push(importedSample(`p-${label}-${i}`, 'pointer', label, featureIndex++, featureDim));
      }
    }
    for (const label of faceLabels) {
      for (let i = 0; i < 10; i += 1) {
        samples.push(importedSample(`f-${label}-${i}`, 'face', label, featureIndex++, featureDim));
      }
    }
    await datasets.commitImportedSamples(samples);
    await db.setMeta(META_KEYS.sharedDataEnabled, true);

    const pointer = new FakeClassifier(pointerLabels);
    const face = new FakeClassifier(faceLabels);
    const service = new ModelService({
      db,
      extractor: fakeExtractor(featureDim),
      pointerClassifier: pointer,
      faceClassifier: face,
    });

    await service.initialize();

    expect(service.getStatus().state).toBe('ready');
    expect(service.isSharedDataEnabled()).toBe(true);
    expect(service.canPlay()).toBe(true);
    expect(pointer.rebuiltWith).toHaveLength(50);
    expect(pointer.rebuiltWith.every((sample) => sample.domain === 'pointer')).toBe(true);
    expect(face.rebuiltWith).toHaveLength(50);
    expect(face.rebuiltWith.every((sample) => sample.domain === 'face')).toBe(true);
  });

  it('Shared OFFへ切り替えるとImported由来Activeを外して両KNNを再構築する', async () => {
    const db = new MemoryDatabase();
    const datasets = new DatasetRepository(db);
    const pointer = new FakeClassifier<PointerLabel>(['up', 'right', 'down', 'left', 'neutral']);
    const face = new FakeClassifier<FaceLabel>(['up', 'right', 'down', 'left', 'front']);
    const featureDim = 2;

    await datasets.commitImportedSamples([
      importedSample('p-up', 'pointer', 'up', 0, featureDim),
      importedSample('f-up', 'face', 'up', 1, featureDim),
    ]);
    await db.setMeta(META_KEYS.sharedDataEnabled, true);

    const service = new ModelService({
      db,
      extractor: fakeExtractor(featureDim),
      pointerClassifier: pointer,
      faceClassifier: face,
    });
    await service.initialize();
    expect(pointer.rebuiltWith).toHaveLength(1);
    expect(face.rebuiltWith).toHaveLength(1);

    await service.setSharedDataEnabled(false);

    expect(service.getStatus().state).toBe('ready');
    expect(service.isSharedDataEnabled()).toBe(false);
    expect(pointer.rebuiltWith).toHaveLength(0);
    expect(face.rebuiltWith).toHaveLength(0);
    expect(service.getActiveIndex().revision).toBeGreaterThan(1);
  });
});
