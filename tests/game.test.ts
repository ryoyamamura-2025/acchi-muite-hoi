import { describe, expect, it } from 'vitest';
import {
  MatchGame,
  type MatchGameDeps,
  type MatchGameState,
} from '../src/game/stateMachine';
import type { JudgeSample } from '../src/game/judge';
import type { AnyLabel, Direction, Domain } from '../src/ml/labels';

function samples(label: AnyLabel, count = 5, confidence = 1): JudgeSample[] {
  return Array.from({ length: count }, () => ({
    label,
    confidences: { [label]: confidence },
  }));
}

function harness(options: {
  playerLabels: AnyLabel[];
  cpuDirections: Direction[];
}) {
  const states: MatchGameState[] = [];
  const calls: string[] = [];
  let playerIndex = 0;
  let cpuIndex = 0;

  const deps: MatchGameDeps = {
    collect: async (domain: Domain, durationMs: number) => {
      calls.push(`collect:${domain}:${durationMs}`);
      const next = options.playerLabels[playerIndex++] ?? 'neutral';
      return samples(next);
    },
    sleep: async () => {},
    randomDirection: () => {
      calls.push('randomDirection');
      return options.cpuDirections[cpuIndex++ % options.cpuDirections.length];
    },
  };

  const game = new MatchGame(deps, (state) => states.push(state), {
    timing: {
      preparingMs: 0,
      attackReadyMs: 0,
      chantMs: 0,
      captureMs: 500,
      resultMs: 0,
    },
  });
  return { game, states, calls, last: () => states[states.length - 1] };
}

describe('Phase 6 MatchGame', () => {
  it('player-firstの攻撃ではPointerを500ms収集し、一致すれば1点勝負が終了する', async () => {
    const h = harness({ playerLabels: ['right'], cpuDirections: ['right'] });

    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });

    expect(h.calls).toContain('collect:pointer:500');
    expect(h.last().phase).toBe('match-over');
    expect(h.last().winner).toBe('player');
    expect(h.last().score).toEqual({ player: 1, cpu: 0 });
  });

  it('cpu-firstの攻撃ではFaceを500ms収集し、一致すればCPUの得点になる', async () => {
    const h = harness({ playerLabels: ['down'], cpuDirections: ['down'] });

    await h.game.startMatch({ firstAttacker: 'cpu-first', targetScore: 1 });

    expect(h.calls).toContain('collect:face:500');
    expect(h.last().winner).toBe('cpu');
    expect(h.last().score).toEqual({ player: 0, cpu: 1 });
  });

  it('方向が違えば得点せず、同じポイント内で攻守だけ交代する', async () => {
    const h = harness({
      playerLabels: ['up', 'down'],
      cpuDirections: ['left', 'down'],
    });

    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });

    const miss = h.states.find((state) => state.result?.outcome === 'miss');
    expect(miss).toMatchObject({
      attacker: 'player',
      pointStarter: 'player',
      pointNumber: 1,
      score: { player: 0, cpu: 0 },
    });
    const cpuAttack = h.states.find(
      (state) => state.phase === 'cpu-attack' && state.pointNumber === 1,
    );
    expect(cpuAttack?.attacker).toBe('cpu');
    expect(h.last().winner).toBe('cpu');
  });

  it('undecidedは得点・攻守・pointStarterを変えず同じ手を再試行する', async () => {
    const h = harness({
      playerLabels: ['neutral', 'right'],
      cpuDirections: ['up', 'right'],
    });

    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });

    const retry = h.states.find((state) => state.phase === 'retry');
    expect(retry).toMatchObject({
      attacker: 'player',
      defender: 'cpu',
      pointStarter: 'player',
      pointNumber: 1,
      score: { player: 0, cpu: 0 },
    });
    const playerAttackStates = h.states.filter((state) => state.phase === 'player-attack');
    expect(playerAttackStates).toHaveLength(2);
    expect(h.last().winner).toBe('player');
  });

  it('3点先取では得点のたびに次ポイントの開始攻撃側が交互になる', async () => {
    const h = harness({
      playerLabels: ['up', 'up', 'up', 'up', 'up'],
      cpuDirections: ['up'],
    });

    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 3 });

    const pointResults = h.states.filter(
      (state) => state.phase === 'result' && state.result?.outcome !== 'miss',
    );
    expect(pointResults.map((state) => state.attacker)).toEqual([
      'player',
      'cpu',
      'player',
      'cpu',
      'player',
    ]);
    expect(pointResults.map((state) => state.pointStarter)).toEqual([
      'player',
      'cpu',
      'player',
      'cpu',
      'player',
    ]);
    expect(h.last().score).toEqual({ player: 3, cpu: 2 });
    expect(h.last().winner).toBe('player');
  });

  it('CPU方向はchant開始時に先に決めるが、resultまではstateへ公開しない', async () => {
    const h = harness({ playerLabels: ['left'], cpuDirections: ['left'] });

    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });

    const randomIndex = h.calls.indexOf('randomDirection');
    const collectIndex = h.calls.indexOf('collect:pointer:500');
    expect(randomIndex).toBeGreaterThanOrEqual(0);
    expect(randomIndex).toBeLessThan(collectIndex);

    for (const state of h.states.filter(
      (state) => state.phase === 'chant' || state.phase === 'judging',
    )) {
      expect(state.cpuDirection).toBeNull();
    }
    const result = h.states.find((state) => state.phase === 'result');
    expect(result?.cpuDirection).toBe('left');
  });

  it('MatchGameStateにじゃんけん状態を持たない', async () => {
    const h = harness({ playerLabels: ['up'], cpuDirections: ['up'] });
    await h.game.startMatch({ firstAttacker: 'player-first', targetScore: 1 });
    expect(h.states.some((state) => 'janken' in state)).toBe(false);
    expect(h.states.some((state) => String(state.phase).includes('janken'))).toBe(false);
  });

  it('targetScoreは1または3だけ受け付ける', async () => {
    const h = harness({ playerLabels: ['up'], cpuDirections: ['up'] });
    await expect(
      h.game.startMatch({ firstAttacker: 'player-first', targetScore: 2 as 1 }),
    ).rejects.toThrow('targetScore');
  });
});
