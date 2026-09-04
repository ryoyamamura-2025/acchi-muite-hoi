import { describe, expect, it } from 'vitest';
import type { AnyLabel, Domain } from '../src/ml/labels';
import {
  ValidationService,
  type ValidationModelSnapshot,
  type ValidationPrediction,
} from '../src/validation/validationService';
import { MemoryValidationStore } from './helpers/memoryValidationStore';

function harness(options: {
  snapshot?: ValidationModelSnapshot;
  prediction?: ValidationPrediction | null;
}) {
  const store = new MemoryValidationStore();
  const snapshot: ValidationModelSnapshot = options.snapshot ?? {
    state: 'ready',
    sharedDataEnabled: false,
    activeDatasetRevision: 7,
  };

  const service = new ValidationService<string>({
    store,
    getModelSnapshot: () => ({ ...snapshot }),
    predict: async (_domain: Domain, _source: string) => options.prediction ?? null,
    now: () => 123456789,
    createId: () => 'validation-1',
  });

  return { service, store };
}

function prediction(label: AnyLabel, confidence: number): ValidationPrediction {
  return { label, confidences: { [label]: confidence } };
}

describe('ValidationService', () => {
  it('意図的なPointer試行だけを必要フィールド付きで保存する', async () => {
    const h = harness({ prediction: prediction('right', 0.82) });

    const result = await h.service.runTrial('pointer', 'right', 'frame');

    expect(result).toEqual({
      validationSessionId: 'validation-1',
      timestamp: 123456789,
      sharedDataEnabled: false,
      domain: 'pointer',
      expectedLabel: 'right',
      predictedLabel: 'right',
      confidence: 0.82,
      activeDatasetRevision: 7,
      decided: true,
    });
    expect(await h.service.listTrials()).toEqual([
      {
        validationSessionId: 'validation-1',
        timestamp: 123456789,
        sharedDataEnabled: false,
        domain: 'pointer',
        expectedLabel: 'right',
        predictedLabel: 'right',
        confidence: 0.82,
        activeDatasetRevision: 7,
      },
    ]);
  });

  it('Face試行ではfrontを正解・予測ラベルとして記録できる', async () => {
    const h = harness({
      snapshot: { state: 'ready', sharedDataEnabled: true, activeDatasetRevision: 12 },
      prediction: prediction('front', 0.91),
    });

    const result = await h.service.runTrial('face', 'front', 'frame');

    expect(result).toMatchObject({
      sharedDataEnabled: true,
      domain: 'face',
      expectedLabel: 'front',
      predictedLabel: 'front',
      confidence: 0.91,
      activeDatasetRevision: 12,
      decided: true,
    });
  });

  it('予測不能も試行としてpredictedLabel/confidenceをnullで保存しdecided=falseを返す', async () => {
    const h = harness({ prediction: null });

    const result = await h.service.runTrial('pointer', 'neutral', 'frame');

    expect(result.predictedLabel).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.decided).toBe(false);
    expect(await h.service.listTrials()).toHaveLength(1);
  });

  it('domainに属さないexpectedLabelは推論前に拒否して保存しない', async () => {
    const h = harness({ prediction: prediction('up', 1) });

    await expect(h.service.runTrial('pointer', 'front', 'frame')).rejects.toThrow('expectedLabel');
    expect(await h.service.listTrials()).toEqual([]);
  });

  it('予測ラベルがdomain不一致なら保存しない', async () => {
    const h = harness({ prediction: prediction('front', 0.8) });

    await expect(h.service.runTrial('pointer', 'up', 'frame')).rejects.toThrow('prediction label');
    expect(await h.service.listTrials()).toEqual([]);
  });

  it('推論中にShared設定が変わった試行は保存しない', async () => {
    const store = new MemoryValidationStore();
    let reads = 0;
    const service = new ValidationService<string>({
      store,
      getModelSnapshot: () => ({
        state: 'ready',
        sharedDataEnabled: reads++ === 0 ? false : true,
        activeDatasetRevision: 7,
      }),
      predict: async () => prediction('up', 0.8),
      now: () => 1,
      createId: () => 'changed-shared',
    });

    await expect(service.runTrial('pointer', 'up', 'frame')).rejects.toThrow('Active Dataset条件');
    expect(await store.list()).toEqual([]);
  });

  it('推論中にActive revisionが変わった試行は保存しない', async () => {
    const store = new MemoryValidationStore();
    let revision = 3;
    const service = new ValidationService<string>({
      store,
      getModelSnapshot: () => ({ state: 'ready', sharedDataEnabled: false, activeDatasetRevision: revision }),
      predict: async () => {
        revision = 4;
        return prediction('left', 0.7);
      },
      now: () => 1,
      createId: () => 'changed-revision',
    });

    await expect(service.runTrial('pointer', 'left', 'frame')).rejects.toThrow('Active Dataset条件');
    expect(await store.list()).toEqual([]);
  });

  it('Classifier ready以外では検証を開始せず保存しない', async () => {
    const h = harness({
      snapshot: { state: 'rebuilding-classifiers', sharedDataEnabled: false, activeDatasetRevision: 2 },
      prediction: prediction('up', 1),
    });

    await expect(h.service.runTrial('pointer', 'up', 'frame')).rejects.toThrow('ready');
    expect(await h.service.listTrials()).toEqual([]);
  });

  it('listTrialsはtimestamp順で返しclearできる', async () => {
    const store = new MemoryValidationStore();
    await store.put({
      validationSessionId: 'later',
      timestamp: 20,
      sharedDataEnabled: false,
      domain: 'pointer',
      expectedLabel: 'up',
      predictedLabel: 'up',
      confidence: 1,
      activeDatasetRevision: 1,
    });
    await store.put({
      validationSessionId: 'earlier',
      timestamp: 10,
      sharedDataEnabled: true,
      domain: 'face',
      expectedLabel: 'front',
      predictedLabel: 'front',
      confidence: 1,
      activeDatasetRevision: 2,
    });

    const service = new ValidationService<string>({
      store,
      getModelSnapshot: () => ({ state: 'ready', sharedDataEnabled: false, activeDatasetRevision: 1 }),
      predict: async () => null,
    });

    expect((await service.listTrials()).map((record) => record.validationSessionId)).toEqual([
      'earlier',
      'later',
    ]);
    await service.clearTrials();
    expect(await service.listTrials()).toEqual([]);
  });
});
