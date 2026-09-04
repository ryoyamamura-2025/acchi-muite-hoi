import { type ClassLabel, type Direction } from '../ml/labels';
import { judgeDirection, type JudgeSample } from './judge';

/**
 * Temporary adapter for the pre-Phase-6 UI only.
 * The backend source of truth is `game/stateMachine.ts`; this file is deleted when the UI is bound to it.
 */
export type Hand = 'rock' | 'scissors' | 'paper';
export type Side = 'player' | 'cpu';
export type Phase = 'idle' | 'janken' | 'countdown' | 'capture' | 'reveal' | 'match-over';
export type RoundOutcome = 'player-point' | 'cpu-point' | 'dodge' | 'undecided';

export interface RoundView {
  playerDirection: Direction | null;
  cpuDirection: Direction | null;
  outcome: RoundOutcome;
}

export interface GameState {
  phase: Phase;
  score: Record<Side, number>;
  attacker: Side | null;
  round: RoundView | null;
  chant: string | null;
  message: string;
  winner: Side | null;
}

export interface GameDeps {
  collect(durationMs: number): Promise<JudgeSample[]>;
  sleep(ms: number): Promise<void>;
  randomDirection(): Direction;
  randomHand(): Hand;
}

export const TARGET_SCORE = 3;
const CHANT_MS = 900;
const CAPTURE_MS = 500;
const REVEAL_MS = 1400;

export const HAND_META: Record<Hand, { ja: string; icon: string }> = {
  rock: { ja: '開始', icon: '▶️' },
  scissors: { ja: '開始', icon: '▶️' },
  paper: { ja: '開始', icon: '▶️' },
};

export function randomHand(): Hand {
  return 'rock';
}

/**
 * 旧UIを壊さないための最小互換アダプタ。
 * 手の種類による勝敗判定は行わず、どの旧ボタンでもデフォルトのplayer攻撃を開始する。
 */
export class Game {
  private state: GameState = initialState();
  private busy = false;

  constructor(
    private readonly deps: GameDeps,
    private readonly onChange: (state: GameState) => void,
  ) {}

  getState(): GameState {
    return { ...this.state, score: { ...this.state.score }, round: this.state.round ? { ...this.state.round } : null };
  }

  reset(): void {
    this.busy = false;
    this.state = initialState();
    this.emit();
  }

  start(): void {
    this.state = { ...initialState(), phase: 'janken', message: '開始ボタンを押してください' };
    this.emit();
  }

  async playHand(_hand: Hand): Promise<void> {
    if (this.state.phase !== 'janken' || this.busy) return;
    this.busy = true;
    try {
      this.state.attacker = 'player';
      await this.runRound();
    } finally {
      this.busy = false;
    }
  }

  private async runRound(): Promise<void> {
    const attacker = this.state.attacker ?? 'player';
    this.update({ phase: 'countdown', chant: 'あっち向いて…', round: null });
    const cpuDirection = this.deps.randomDirection();
    await this.deps.sleep(CHANT_MS);
    this.update({ phase: 'capture', chant: 'ほい！' });
    const judged = judgeDirection(await this.deps.collect(CAPTURE_MS));

    if (judged.kind === 'undecided') {
      this.update({
        phase: 'reveal',
        chant: null,
        round: { playerDirection: null, cpuDirection: null, outcome: 'undecided' },
        message: '判定できませんでした。もう一度',
      });
      await this.deps.sleep(REVEAL_MS);
      this.update({ phase: 'janken', round: null, message: 'もう一度開始してください' });
      return;
    }

    const playerDirection = judged.direction;
    const matched = playerDirection === cpuDirection;
    const outcome: RoundOutcome = matched
      ? attacker === 'player'
        ? 'player-point'
        : 'cpu-point'
      : 'dodge';
    const score = { ...this.state.score };
    if (outcome === 'player-point') score.player += 1;
    if (outcome === 'cpu-point') score.cpu += 1;

    this.update({
      phase: 'reveal',
      chant: null,
      score,
      round: { playerDirection, cpuDirection, outcome },
      message: matched ? '方向一致！' : '方向が違いました',
    });
    await this.deps.sleep(REVEAL_MS);

    const winner: Side | null =
      score.player >= TARGET_SCORE ? 'player' : score.cpu >= TARGET_SCORE ? 'cpu' : null;
    if (winner) {
      this.update({ phase: 'match-over', winner, message: winner === 'player' ? 'あなたの勝ち！' : 'CPUの勝ち！' });
      return;
    }
    this.update({ phase: 'janken', attacker: null, round: null, message: '次の手へ' });
  }

  private update(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    this.onChange(this.getState());
  }
}

function initialState(): GameState {
  return {
    phase: 'idle',
    score: { player: 0, cpu: 0 },
    attacker: null,
    round: null,
    chant: null,
    message: '',
    winner: null,
  };
}

export type LegacyClassLabel = ClassLabel;
