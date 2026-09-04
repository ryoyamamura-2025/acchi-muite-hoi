import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_TUNING } from '../src/config/tuning';
import { DEFAULT_GAME_TIMING, MatchGame } from '../src/game/stateMachine';
import type { JudgeSample } from '../src/game/judge';
import { DEFAULT_CLASSIFIER_CONFIG } from '../src/ml/classifier';
import { DEFAULT_SAMPLE_SELECTOR_CONFIG } from '../src/ml/sampleSelector';
import { DEFAULT_TRAINING_SESSION_CONFIG } from '../src/training/trainingSession';

function samples(direction: 'up' | 'right' | 'down' | 'left'): JudgeSample[] {
  return Array.from({ length: 5 }, () => ({
    label: direction,
    confidences: { [direction]: 1 },
  }));
}

describe('Phase 8 tuning defaults', () => {
  it('classifier / selector / training / gameの初期値が中央tuning設定から供給される', () => {
    expect(DEFAULT_CLASSIFIER_CONFIG.pointer.k).toBe(DEFAULT_RUNTIME_TUNING.pointer.k);
    expect(DEFAULT_CLASSIFIER_CONFIG.face.k).toBe(DEFAULT_RUNTIME_TUNING.face.k);
    expect(DEFAULT_CLASSIFIER_CONFIG.pointer.confidenceThreshold).toBe(
      DEFAULT_RUNTIME_TUNING.pointer.confidenceThreshold,
    );
    expect(DEFAULT_CLASSIFIER_CONFIG.face.minValidRatio).toBe(
      DEFAULT_RUNTIME_TUNING.face.minValidRatio,
    );
    expect(DEFAULT_SAMPLE_SELECTOR_CONFIG.pointer.similarityThreshold).toBe(
      DEFAULT_RUNTIME_TUNING.pointer.similarityThreshold,
    );
    expect(DEFAULT_SAMPLE_SELECTOR_CONFIG.face.similarityThreshold).toBe(
      DEFAULT_RUNTIME_TUNING.face.similarityThreshold,
    );
    expect(DEFAULT_TRAINING_SESSION_CONFIG.candidateIntervalMs).toBe(
      DEFAULT_RUNTIME_TUNING.training.candidateIntervalMs,
    );
    expect(DEFAULT_GAME_TIMING.captureMs).toBe(DEFAULT_RUNTIME_TUNING.game.judgeWindowMs);
  });

  it('game judge windowは500ms固定ではなく実機調整値でoverrideできる', async () => {
    const durations: number[] = [];
    const game = new MatchGame(
      {
        collect: async (_domain, durationMs) => {
          durations.push(durationMs);
          return samples('right');
        },
        sleep: async () => {},
        randomDirection: () => 'right',
      },
      () => {},
      {
        timing: {
          preparingMs: 0,
          attackReadyMs: 0,
          chantMs: 0,
          captureMs: 420,
          resultMs: 0,
        },
      },
    );

    await game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });
    expect(durations).toEqual([420]);
  });

  it('game judge windowは正の値だけ受け付ける', () => {
    expect(
      () =>
        new MatchGame(
          {
            collect: async () => [],
            sleep: async () => {},
            randomDirection: () => 'up',
          },
          () => {},
          { timing: { captureMs: 0 } },
        ),
    ).toThrow('captureMs');
  });
});
