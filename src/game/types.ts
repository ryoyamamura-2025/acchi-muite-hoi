import type { Direction } from '../ml/labels';

export type Side = 'player' | 'cpu';
export type FirstAttacker = 'player-first' | 'cpu-first';
export type TargetScore = 1 | 3;

export type GamePhase =
  | 'idle'
  | 'preparing'
  | 'player-attack'
  | 'cpu-attack'
  | 'chant'
  | 'judging'
  | 'result'
  | 'retry'
  | 'match-over';

export type HandOutcome = 'player-point' | 'cpu-point' | 'miss' | 'undecided';
export type UndecidedReason = 'no-samples' | 'too-few-valid' | 'low-confidence';

export interface MatchOptions {
  firstAttacker: FirstAttacker;
  targetScore: TargetScore;
}

export interface HandResultView {
  playerDirection: Direction | null;
  /** CPU方向はresult時だけ公開する。判定前はGameState.cpuDirectionもnull。 */
  cpuDirection: Direction | null;
  outcome: HandOutcome;
  confidence: number | null;
  undecidedReason: UndecidedReason | null;
}

export interface GameState {
  phase: GamePhase;
  score: Record<Side, number>;
  targetScore: TargetScore | null;
  attacker: Side | null;
  defender: Side | null;
  /** 現在のポイントを開始した攻撃側。得点後に必ず反転する。 */
  pointStarter: Side | null;
  /** 1始まり。対戦前は0。 */
  pointNumber: number;
  /** 公開可能になったCPU方向。chant/judging中は必ずnull。 */
  cpuDirection: Direction | null;
  playerDirection: Direction | null;
  result: HandResultView | null;
  chant: string | null;
  message: string;
  winner: Side | null;
}

export function sideFromFirstAttacker(firstAttacker: FirstAttacker): Side {
  return firstAttacker === 'player-first' ? 'player' : 'cpu';
}

export function oppositeSide(side: Side): Side {
  return side === 'player' ? 'cpu' : 'player';
}
