import { describe, expect, it } from 'vitest';
import { MatchGame, type MatchGameDeps } from '../src/game/stateMachine';
import type { GameSoundCue, GameSoundPort } from '../src/game/sound';

function confidentRightSamples() {
  return Array.from({ length: 5 }, () => ({
    label: 'right' as const,
    confidences: { right: 1 },
  }));
}

describe('game sound feedback', () => {
  it('ユーザー操作で音を解錠し、主要フェーズのSEを順番に鳴らす', async () => {
    const cues: Array<'unlock' | GameSoundCue> = [];
    const sound: GameSoundPort = {
      unlock: () => cues.push('unlock'),
      play: (cue) => cues.push(cue),
    };
    const deps: MatchGameDeps = {
      collect: async () => confidentRightSamples(),
      sleep: async () => {},
      randomDirection: () => 'right',
      sound,
    };
    const game = new MatchGame(deps, () => {}, {
      timing: {
        preparingMs: 0,
        attackReadyMs: 0,
        chantMs: 0,
        captureMs: 500,
        resultMs: 0,
      },
    });

    await game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });

    expect(cues).toEqual([
      'unlock',
      'start',
      'chant',
      'hoi',
      'player-point',
      'win',
    ]);
  });
});
