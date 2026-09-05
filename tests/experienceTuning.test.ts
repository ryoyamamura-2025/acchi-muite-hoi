import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_TUNING } from '../src/config/tuning';
import { DEFAULT_GAME_TIMING } from '../src/game/stateMachine';

describe('mobile experience tuning', () => {
  it('1カテゴリの学習時間を5秒にする', () => {
    expect(DEFAULT_RUNTIME_TUNING.training.durationMs).toBe(5000);
  });

  it('対戦中にプレイヤーが追いつける間を確保する', () => {
    expect(DEFAULT_GAME_TIMING).toMatchObject({
      preparingMs: 800,
      attackReadyMs: 900,
      chantMs: 1200,
      resultMs: 1800,
    });
  });
});
