import { describe, expect, it } from 'vitest';
import { SimilarityCacheRepository } from '../src/data/similarityCache';
import type { AnyLabel, Domain } from '../src/ml/labels';
import {
  DEFAULT_SAMPLE_SELECTOR_CONFIG,
  selectRepresentativeSamples,
  type SampleSelectorConfig,
} from '../src/ml/sampleSelector';
import {
  cosineSimilarity,
  createSimilarityCacheEntry,
  makeSimilarityPairKey,
} from '../src/ml/similarity';
import type { Sample } from '../src/ml/types';
import { makeSampleKey } from '../src/ml/types';
import { MemoryDatabase } from './helpers/memoryDatabase';

describe('cosineSimilarity', () => {
  it('同方向は1、直交は0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it('feature dimension不一致を拒否する', () => {
    expect(() =>
      cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])),
    ).toThrow(/dimension mismatch/);
  });

  it('pair keyはsample順序に依存しない', () => {
    expect(makeSimilarityPairKey('b', 'a')).toBe(makeSimilarityPairKey('a', 'b'));
  });
});

describe('selectRepresentativeSamples', () => {
  it('threshold以上の類似sampleを拒否する', () => {
    const existing = [sample('pointer', 'up', 'old', [1, 0], 1)];
    const candidate = sample('pointer', 'up', 'new', [0.999, 0.01], 2);

    const result = selectRepresentativeSamples(existing, [candidate], 'pointer', 'up');

    expect(result.samples.map((value) => value.id)).toEqual(['old']);
    expect(result.acceptedCandidates).toHaveLength(0);
    expect(result.duplicateCandidates.map((value) => value.id)).toEqual(['new']);
  });

  it('十分異なるsampleを採用する', () => {
    const existing = [sample('pointer', 'left', 'old', [1, 0], 1)];
    const candidate = sample('pointer', 'left', 'new', [0, 1], 2);

    const result = selectRepresentativeSamples(existing, [candidate], 'pointer', 'left');

    expect(result.samples.map((value) => value.id)).toEqual(['old', 'new']);
    expect(result.acceptedCandidates.map((value) => value.id)).toEqual(['new']);
    expect(result.duplicateCandidates).toHaveLength(0);
    expect(result.cacheEntries).toHaveLength(1);
  });

  it('100→101件では最類似pairの古い方を削除し100件を維持する', () => {
    const dimension = 101;
    const existing: Sample[] = [];

    const first = unitVector(dimension, 0);
    existing.push(sample('pointer', 'right', 's0', first, 10));

    const second = new Float32Array(dimension);
    second[0] = 0.95;
    second[1] = Math.sqrt(1 - 0.95 ** 2);
    existing.push(sample('pointer', 'right', 's1', second, 20));

    for (let i = 2; i < 100; i += 1) {
      existing.push(sample('pointer', 'right', `s${i}`, unitVector(dimension, i), 100 + i));
    }

    const candidate = sample('pointer', 'right', 's100', unitVector(dimension, 100), 1000);
    const result = selectRepresentativeSamples(existing, [candidate], 'pointer', 'right');

    expect(result.samples).toHaveLength(100);
    expect(result.samples.some((value) => value.id === 's100')).toBe(true);
    expect(result.samples.some((value) => value.id === 's0')).toBe(false);
    expect(result.evictedSamples.map((value) => value.id)).toEqual(['s0']);
  });

  it('最類似pairではsample key順ではなくcapturedAtが古い方を削除する', () => {
    const config: SampleSelectorConfig = {
      pointer: { similarityThreshold: 0.98, maxSamplesPerClass: 2 },
      face: DEFAULT_SAMPLE_SELECTOR_CONFIG.face,
    };
    const a = sample('pointer', 'down', 'a', [1, 0, 0], 200);
    const b = sample('pointer', 'down', 'b', [0.9, Math.sqrt(1 - 0.9 ** 2), 0], 100);
    const candidate = sample('pointer', 'down', 'c', [0, 0, 1], 300);

    const result = selectRepresentativeSamples([a, b], [candidate], 'pointer', 'down', [], config);

    expect(result.evictedSamples.map((value) => value.id)).toEqual(['b']);
    expect(result.samples.map((value) => value.id).sort()).toEqual(['a', 'c']);
  });

  it('Pointer / Faceのsimilarity thresholdを独立設定できる', () => {
    const config: SampleSelectorConfig = {
      pointer: { similarityThreshold: 0.85, maxSamplesPerClass: 100 },
      face: { similarityThreshold: 0.95, maxSamplesPerClass: 100 },
    };
    const near = [0.9, Math.sqrt(1 - 0.9 ** 2)];

    const pointerResult = selectRepresentativeSamples(
      [sample('pointer', 'up', 'p0', [1, 0], 1)],
      [sample('pointer', 'up', 'p1', near, 2)],
      'pointer',
      'up',
      [],
      config,
    );
    const faceResult = selectRepresentativeSamples(
      [sample('face', 'up', 'f0', [1, 0], 1)],
      [sample('face', 'up', 'f1', near, 2)],
      'face',
      'up',
      [],
      config,
    );

    expect(pointerResult.duplicateCandidates).toHaveLength(1);
    expect(faceResult.acceptedCandidates).toHaveLength(1);
  });

  it('欠損cacheを特徴量から再生成して上限判定できる', () => {
    const config: SampleSelectorConfig = {
      pointer: { similarityThreshold: 0.98, maxSamplesPerClass: 2 },
      face: DEFAULT_SAMPLE_SELECTOR_CONFIG.face,
    };
    const a = sample('pointer', 'up', 'a', [1, 0, 0], 1);
    const b = sample('pointer', 'up', 'b', [0.9, Math.sqrt(1 - 0.9 ** 2), 0], 2);
    const c = sample('pointer', 'up', 'c', [0, 0, 1], 3);

    const result = selectRepresentativeSamples([a, b], [c], 'pointer', 'up', [], config);

    expect(result.samples).toHaveLength(2);
    expect(result.cacheEntries).toHaveLength(1);
  });
});

describe('SimilarityCacheRepository', () => {
  it('classごとにcacheを保存・復元・削除できる', async () => {
    const db = new MemoryDatabase();
    const repository = new SimilarityCacheRepository(db);
    const entry = createSimilarityCacheEntry('install:a', 'install:b', 0.5);

    await repository.replaceClass('pointer', 'up', [entry]);
    expect(await repository.getClass('pointer', 'up')).toEqual([entry]);
    expect(await repository.getClass('face', 'up')).toEqual([]);

    await repository.clearClass('pointer', 'up');
    expect(await repository.getClass('pointer', 'up')).toEqual([]);
  });
});

function sample(
  domain: Domain,
  label: AnyLabel,
  id: string,
  feature: readonly number[] | Float32Array,
  capturedAt: number,
): Sample {
  const base = {
    id,
    feature: feature instanceof Float32Array ? feature : new Float32Array(feature),
    capturedAt,
    captureSessionId: 'session',
    sourceInstallationId: 'install',
  };

  if (domain === 'pointer') {
    if (label === 'front') throw new Error('frontはPointer labelではありません');
    return { ...base, domain, label };
  }
  if (label === 'neutral') throw new Error('neutralはFace labelではありません');
  return { ...base, domain, label };
}

function unitVector(dimension: number, index: number): Float32Array {
  const vector = new Float32Array(dimension);
  vector[index] = 1;
  return vector;
}

// makeSampleKeyもPhase 2でcache keyの一部として使うため、型上の接続を確認しておく。
void makeSampleKey;
