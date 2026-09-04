import { describe, expect, it } from 'vitest';
import { DatasetRepository } from '../src/data/datasetRepository';
import type { AnyLabel, Domain } from '../src/ml/labels';
import type { SimilarityCacheEntry } from '../src/ml/similarity';
import type { Sample } from '../src/ml/types';
import { SimilarityCacheRepository } from '../src/data/similarityCache';
import {
  TrainingSession,
  type TrainingState,
} from '../src/training/trainingSession';
import { MemoryDatabase } from './helpers/memoryDatabase';

const INSTALLATION_ID = 'installation-a';

function pointerSample(options: {
  id: string;
  feature: number[];
  capturedAt?: number;
  label?: 'up' | 'right' | 'down' | 'left' | 'neutral';
}): Sample {
  return {
    id: options.id,
    domain: 'pointer',
    label: options.label ?? 'up',
    feature: new Float32Array(options.feature),
    capturedAt: options.capturedAt ?? 1,
    captureSessionId: 'old-session',
    sourceInstallationId: INSTALLATION_ID,
  };
}

function createHarness(options: {
  db?: MemoryDatabase;
  captureFeature?: (signal: AbortSignal, index: number) => Promise<Float32Array>;
} = {}) {
  const db = options.db ?? new MemoryDatabase();
  const datasetRepository = new DatasetRepository(db);
  const similarityCacheRepository = new SimilarityCacheRepository(db);
  const states: TrainingState[] = [];
  let monotonic = 0;
  let captureIndex = 0;
  let idCounter = 0;

  const session = new TrainingSession(
    {
      datasetRepository,
      similarityCacheRepository,
      installationId: INSTALLATION_ID,
      captureFeature: async (signal) => {
        const index = captureIndex++;
        if (options.captureFeature) return options.captureFeature(signal, index);
        const feature = new Float32Array(8);
        feature[index] = 1;
        return feature;
      },
      now: () => monotonic,
      timestamp: () => 1_000_000 + monotonic,
      sleep: async (ms, signal) => {
        if (signal.aborted) throw new Error('cancelled');
        monotonic += ms;
      },
      createId: () => `id-${++idCounter}`,
      onStatusChanged: (status) => states.push(status.state),
    },
  );

  return { db, datasetRepository, similarityCacheRepository, session, states };
}

describe('TrainingSession', () => {
  it('3秒sessionの中央安定区間だけを約300ms間隔で候補化し、一括保存する', async () => {
    const h = createHarness();

    const result = await h.session.start('pointer', 'up');

    expect(result).toMatchObject({
      kind: 'completed',
      candidateCount: 7,
      acceptedCount: 7,
      duplicateCount: 0,
      evictedCount: 0,
      totalClassSamples: 7,
    });

    const saved = await h.datasetRepository.getLocalSamples({ domain: 'pointer', label: 'up' });
    expect(saved).toHaveLength(7);
    expect(saved.map((sample) => sample.capturedAt)).toEqual([
      1_000_600,
      1_000_900,
      1_001_200,
      1_001_500,
      1_001_800,
      1_002_100,
      1_002_400,
    ]);
    expect(new Set(saved.map((sample) => sample.captureSessionId)).size).toBe(1);
    expect(h.states).toEqual([
      'preparing',
      'capturing',
      'capturing',
      'capturing',
      'capturing',
      'capturing',
      'capturing',
      'capturing',
      'capturing',
      'processing',
      'processing',
      'saving',
      'completed',
    ]);
  });

  it('既存sampleと十分類似していれば追加0件で正常終了する', async () => {
    const h = createHarness({
      captureFeature: async () => new Float32Array([1, 0]),
    });
    await h.datasetRepository.commitLocalSamples(
      [pointerSample({ id: 'existing', feature: [1, 0] })],
      INSTALLATION_ID,
    );

    const result = await h.session.start('pointer', 'up');

    expect(result).toMatchObject({
      kind: 'completed',
      candidateCount: 7,
      acceptedCount: 0,
      duplicateCount: 7,
      totalClassSamples: 1,
    });
    const saved = await h.datasetRepository.getLocalSamples({ domain: 'pointer', label: 'up' });
    expect(saved.map((sample) => sample.id)).toEqual(['existing']);
    expect(h.states).not.toContain('saving');
  });

  it('cancelされたsessionはmemory上の候補を破棄し、Local Datasetを変更しない', async () => {
    let session!: TrainingSession;
    const h = createHarness({
      captureFeature: async () => {
        session.cancel();
        return new Float32Array([0, 1]);
      },
    });
    session = h.session;
    await h.datasetRepository.commitLocalSamples(
      [pointerSample({ id: 'existing', feature: [1, 0] })],
      INSTALLATION_ID,
    );

    const result = await h.session.start('pointer', 'up');

    expect(result).toMatchObject({ kind: 'cancelled', candidateCount: 0 });
    const saved = await h.datasetRepository.getLocalSamples({ domain: 'pointer', label: 'up' });
    expect(saved.map((sample) => sample.id)).toEqual(['existing']);
    expect(h.session.getStatus().state).toBe('cancelled');
  });

  it('feature抽出エラー時はsessionをerrorにし、何もcommitしない', async () => {
    const h = createHarness({
      captureFeature: async () => {
        throw new Error('camera stopped');
      },
    });
    await h.datasetRepository.commitLocalSamples(
      [pointerSample({ id: 'existing', feature: [1, 0] })],
      INSTALLATION_ID,
    );

    const result = await h.session.start('pointer', 'up');

    expect(result.kind).toBe('error');
    const saved = await h.datasetRepository.getLocalSamples({ domain: 'pointer', label: 'up' });
    expect(saved.map((sample) => sample.id)).toEqual(['existing']);
    expect(h.session.getStatus()).toMatchObject({
      state: 'error',
      errorMessage: 'camera stopped',
    });
  });

  it('IndexedDB commitが失敗しても既存classを中途半端に更新しない', async () => {
    const db = new FailingCommitDatabase();
    const h = createHarness({ db });
    await h.datasetRepository.commitLocalSamples(
      [pointerSample({ id: 'existing', feature: [0, 0, 0, 0, 0, 0, 0, 1] })],
      INSTALLATION_ID,
    );

    const result = await h.session.start('pointer', 'up');

    expect(result.kind).toBe('error');
    const saved = await h.datasetRepository.getLocalSamples({ domain: 'pointer', label: 'up' });
    expect(saved.map((sample) => sample.id)).toEqual(['existing']);
  });

  it('Face/frontもPointerとは独立したclassとして学習できる', async () => {
    const h = createHarness();

    const result = await h.session.start('face', 'front');

    expect(result).toMatchObject({ kind: 'completed', acceptedCount: 7 });
    expect(await h.datasetRepository.getLocalSamples({ domain: 'face', label: 'front' })).toHaveLength(7);
    expect(await h.datasetRepository.getLocalSamples({ domain: 'pointer' })).toHaveLength(0);
  });

  it('同時に2つのsessionを開始できない', async () => {
    let releaseCapture!: () => void;
    const captureWait = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const h = createHarness({
      captureFeature: async () => {
        await captureWait;
        return new Float32Array([1, 0]);
      },
    });

    const first = h.session.start('pointer', 'up');
    await Promise.resolve();
    await expect(h.session.start('pointer', 'right')).rejects.toThrow('already running');
    h.session.cancel();
    releaseCapture();
    await first;
  });
});

class FailingCommitDatabase extends MemoryDatabase {
  override async commitLocalClassSelection(
    _domain: Domain,
    _label: AnyLabel,
    _samples: readonly Sample[],
    _cacheEntries: readonly SimilarityCacheEntry[],
  ): Promise<void> {
    throw new Error('quota exceeded');
  }
}
