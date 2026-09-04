import { describe, expect, it } from 'vitest';
import { Game, GameDeps, GameState, Hand, TARGET_SCORE } from '../src/game/stateMachine';
import { JudgeSample } from '../src/game/judge';
import { ClassLabel, Direction, emptyConfidences } from '../src/ml/labels';

function samples(label: ClassLabel, count = 5): JudgeSample[] {
  const confidences = emptyConfidences();
  confidences[label] = 1;
  return Array.from({ length: count }, () => ({ label, confidences }));
}

/**
 * 決め打ちの手・方向を順番に返すテスト用の依存。
 * `sleep` は即解決させるので進行が最後まで走り切る。
 */
function harness(options: {
  playerDirections: (ClassLabel | 'none')[];
  cpuDirections: Direction[];
  cpuHands: Hand[];
}) {
  const states: GameState[] = [];
  let directionIndex = 0;
  let cpuIndex = 0;
  let handIndex = 0;

  const deps: GameDeps = {
    collect: async () => {
      const next = options.playerDirections[directionIndex++] ?? 'none';
      return next === 'none' ? [] : samples(next);
    },
    sleep: async () => {},
    randomDirection: () => options.cpuDirections[cpuIndex++ % options.cpuDirections.length],
    randomHand: () => options.cpuHands[handIndex++ % options.cpuHands.length],
  };

  const game = new Game(deps, (state) => states.push(state));
  return { game, states, last: () => states[states.length - 1] };
}

describe('Game', () => {
  it('じゃんけんに勝つとプレイヤーが攻めになる', async () => {
    const h = harness({ playerDirections: ['up'], cpuDirections: ['left'], cpuHands: ['scissors'] });
    h.game.start();
    await h.game.playHand('rock');
    expect(h.states.some((s) => s.attacker === 'player')).toBe(true);
  });

  it('あいこならじゃんけんに戻り攻守は決まらない', async () => {
    const h = harness({ playerDirections: [], cpuDirections: ['up'], cpuHands: ['rock'] });
    h.game.start();
    await h.game.playHand('rock');
    expect(h.last().phase).toBe('janken');
    expect(h.last().attacker).toBeNull();
    expect(h.last().janken?.outcome).toBe('draw');
  });

  it('攻めていて方向が一致すればプレイヤーの得点', async () => {
    const h = harness({
      playerDirections: ['right'],
      cpuDirections: ['right'],
      cpuHands: ['scissors'],
    });
    h.game.start();
    await h.game.playHand('rock');
    const reveal = h.states.find((s) => s.phase === 'reveal')!;
    expect(reveal.round?.outcome).toBe('player-point');
    expect(reveal.score.player).toBe(1);
    expect(h.last().phase).toBe('janken');
  });

  it('攻めていて方向が違えば得点にならない', async () => {
    const h = harness({ playerDirections: ['up'], cpuDirections: ['left'], cpuHands: ['scissors'] });
    h.game.start();
    await h.game.playHand('rock');
    const reveal = h.states.find((s) => s.phase === 'reveal')!;
    expect(reveal.round?.outcome).toBe('dodge');
    expect(reveal.score).toEqual({ player: 0, cpu: 0 });
  });

  it('守っていて同じ方向を向くと CPU の得点', async () => {
    const h = harness({ playerDirections: ['down'], cpuDirections: ['down'], cpuHands: ['paper'] });
    h.game.start();
    await h.game.playHand('rock');
    const reveal = h.states.find((s) => s.phase === 'reveal')!;
    expect(reveal.attacker).toBe('cpu');
    expect(reveal.round?.outcome).toBe('cpu-point');
    expect(reveal.score.cpu).toBe(1);
  });

  it('判定できなかった場合は攻守を変えずにやり直す', async () => {
    const h = harness({
      playerDirections: ['neutral', 'right'],
      cpuDirections: ['right'],
      cpuHands: ['scissors'],
    });
    h.game.start();
    await h.game.playHand('rock');
    const undecided = h.states.find((s) => s.round?.outcome === 'undecided')!;
    expect(undecided.attacker).toBe('player');
    expect(h.last().score.player).toBe(1);
  });

  it('判定できないラウンドが続いてもじゃんけんに戻る（無限ループしない）', async () => {
    const h = harness({ playerDirections: [], cpuDirections: ['up'], cpuHands: ['scissors'] });
    h.game.start();
    await h.game.playHand('rock');
    expect(h.last().phase).toBe('janken');
    expect(h.last().attacker).toBeNull();
    expect(h.last().score).toEqual({ player: 0, cpu: 0 });
  });

  it('先に TARGET_SCORE 点取ると試合終了', async () => {
    const h = harness({
      playerDirections: Array.from({ length: TARGET_SCORE }, () => 'right' as ClassLabel),
      cpuDirections: ['right'],
      cpuHands: ['scissors'],
    });
    h.game.start();
    for (let i = 0; i < TARGET_SCORE; i++) await h.game.playHand('rock');
    expect(h.last().phase).toBe('match-over');
    expect(h.last().winner).toBe('player');
    expect(h.last().score.player).toBe(TARGET_SCORE);
  });

  it('ゲーム開始前はじゃんけんの手を受け付けない', async () => {
    const h = harness({ playerDirections: [], cpuDirections: ['up'], cpuHands: ['rock'] });
    await h.game.playHand('rock');
    expect(h.states).toHaveLength(0);
  });
});
