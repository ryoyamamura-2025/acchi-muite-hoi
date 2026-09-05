import { describe, expect, it } from 'vitest';
import { MatchGame, type MatchGameDeps } from '../src/game/stateMachine';
import {
  createBrowserGameSound,
  type GameSoundCue,
  type GameSoundPort,
} from '../src/game/sound';

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

  it('AudioContext.resume完了前のSEを捨てず、runningになってから再生する', async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let releaseResume!: () => void;
    let oscillatorStarts = 0;

    class FakeAudioContext {
      state: AudioContextState = 'suspended';
      currentTime = 0;
      destination = {};

      resume(): Promise<void> {
        return new Promise((resolve) => {
          releaseResume = () => {
            this.state = 'running';
            resolve();
          };
        });
      }

      createOscillator(): OscillatorNode {
        return {
          type: 'sine',
          frequency: { setValueAtTime: () => undefined },
          connect: () => undefined,
          start: () => {
            oscillatorStarts += 1;
          },
          stop: () => undefined,
        } as unknown as OscillatorNode;
      }

      createGain(): GainNode {
        return {
          gain: {
            setValueAtTime: () => undefined,
            exponentialRampToValueAtTime: () => undefined,
          },
          connect: () => undefined,
        } as unknown as GainNode;
      }
    }

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext as unknown as typeof AudioContext,
      },
    });

    try {
      const sound = createBrowserGameSound();
      sound.unlock();
      sound.play('start');

      expect(oscillatorStarts).toBe(0);

      releaseResume();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(oscillatorStarts).toBe(2);
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
