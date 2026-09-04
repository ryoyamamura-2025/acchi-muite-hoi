import { Direction } from '../ml/labels';
import { JudgeSample, judgeDirection } from './judge';

export type Hand = 'rock' | 'scissors' | 'paper';
export type Side = 'player' | 'cpu';

export type Phase =
  | 'idle'
  | 'janken'
  | 'janken-reveal'
  | 'countdown'
  | 'capture'
  | 'reveal'
  | 'match-over';

export type RoundOutcome = 'player-point' | 'cpu-point' | 'dodge' | 'undecided';

export interface JankenView {
  player: Hand;
  cpu: Hand;
  outcome: 'win' | 'lose' | 'draw';
}

export interface RoundView {
  /** プレイヤーが出した方向。攻めなら「指さした方向」、守りなら「顔を向けた方向」。 */
  playerDirection: Direction | null;
  /** CPU が出した方向。キャプチャ開始時に決まっていて、公開は reveal 時。 */
  cpuDirection: Direction | null;
  outcome: RoundOutcome;
}

export interface GameState {
  phase: Phase;
  score: Record<Side, number>;
  attacker: Side | null;
  janken: JankenView | null;
  round: RoundView | null;
  /** 「あっち向いて…」「ほい！」の掛け声。 */
  chant: string | null;
  message: string;
  winner: Side | null;
}

export interface GameDeps {
  /** 指定時間のあいだ推論結果を集める。 */
  collect(durationMs: number): Promise<JudgeSample[]>;
  sleep(ms: number): Promise<void>;
  randomDirection(): Direction;
  randomHand(): Hand;
}

export const TARGET_SCORE = 3;
const CHANT_MS = 900;
const CAPTURE_MS = 500;
const REVEAL_MS = 1900;
const JANKEN_REVEAL_MS = 1200;
/** 判定できないラウンドを繰り返す上限。これを超えたらじゃんけんに戻す。 */
const MAX_UNDECIDED_RETRIES = 3;

const HANDS: readonly Hand[] = ['rock', 'scissors', 'paper'];
/** じゃんけんの勝ち関係（キーが値に勝つ）。 */
const BEATS: Record<Hand, Hand> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export const HAND_META: Record<Hand, { ja: string; icon: string }> = {
  rock: { ja: 'グー', icon: '✊' },
  scissors: { ja: 'チョキ', icon: '✌️' },
  paper: { ja: 'パー', icon: '🖐️' },
};

export function randomHand(): Hand {
  return HANDS[Math.floor(Math.random() * HANDS.length)];
}

export function judgeJanken(player: Hand, cpu: Hand): JankenView['outcome'] {
  if (player === cpu) return 'draw';
  return BEATS[player] === cpu ? 'win' : 'lose';
}

/**
 * 「あっち向いてほい」の進行役。
 *
 * じゃんけん → 攻守決定 → 掛け声 → 「ほい！」で画像認識 → 判定 を繰り返し、
 * どちらかが {@link TARGET_SCORE} 点先取したら終わり。
 *
 * 初版ではプレイヤーは常に「指さし」で方向を示す（攻守は役割だけ入れ替わる）。
 * 顔の向き自体を認識させるには別クラスの学習が必要なため。
 */
export class Game {
  private state: GameState = initialState();
  private busy = false;

  constructor(
    private readonly deps: GameDeps,
    private readonly onChange: (state: GameState) => void,
  ) {}

  getState(): GameState {
    return this.state;
  }

  reset(): void {
    this.busy = false;
    this.state = initialState();
    this.emit();
  }

  start(): void {
    this.busy = false;
    this.state = { ...initialState(), phase: 'janken', message: 'じゃんけんで攻める人を決めよう！' };
    this.emit();
  }

  /** じゃんけんの手を出す。UI のボタンから呼ばれる。 */
  async playHand(hand: Hand): Promise<void> {
    if (this.state.phase !== 'janken' || this.busy) return;
    this.busy = true;
    try {
      const cpu = this.deps.randomHand();
      const outcome = judgeJanken(hand, cpu);
      this.update({
        phase: 'janken-reveal',
        janken: { player: hand, cpu, outcome },
        round: null,
        message:
          outcome === 'draw'
            ? 'あいこ！ もう一回'
            : outcome === 'win'
              ? 'じゃんけんに勝った！ あなたが指さす番'
              : 'じゃんけんに負けた… CPU が指さす番',
      });
      await this.deps.sleep(JANKEN_REVEAL_MS);

      if (outcome === 'draw') {
        this.update({ phase: 'janken', message: 'あいこ！ もう一度じゃんけん' });
        return;
      }

      this.update({ attacker: outcome === 'win' ? 'player' : 'cpu' });
      await this.runRounds();
    } finally {
      this.busy = false;
    }
  }

  /**
   * 判定できなかった場合は同じ攻守でやり直す。
   * ただしカメラが止まっているときに永久に回らないよう回数を制限する。
   */
  private async runRounds(): Promise<void> {
    for (let attempt = 0; attempt <= MAX_UNDECIDED_RETRIES; attempt++) {
      const outcome = await this.runRound();
      if (outcome !== 'undecided') return;
    }
    this.update({
      phase: 'janken',
      attacker: null,
      chant: null,
      round: null,
      message: '判定できませんでした。カメラの前で大きく指さして、じゃんけんからやり直してください',
    });
  }

  private async runRound(): Promise<RoundOutcome> {
    const attacker = this.state.attacker;
    if (!attacker) return 'undecided';

    this.update({
      phase: 'countdown',
      chant: 'あっち向いて…',
      round: null,
      message:
        attacker === 'player'
          ? '「ほい！」で指さす方向を出して'
          : '「ほい！」で顔を向ける方向を出して',
    });
    await this.deps.sleep(CHANT_MS);

    // CPU の方向はキャプチャ開始時に決めておく（プレイヤーの結果に依存させない）。
    const cpuDirection = this.deps.randomDirection();

    this.update({ phase: 'capture', chant: 'ほい！' });
    const samples = await this.deps.collect(CAPTURE_MS);
    const judged = judgeDirection(samples);

    if (judged.kind === 'undecided') {
      this.update({
        phase: 'reveal',
        chant: null,
        round: { playerDirection: null, cpuDirection: null, outcome: 'undecided' },
        message: undecidedMessage(judged.reason),
      });
      await this.deps.sleep(REVEAL_MS);
      return 'undecided';
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
      message: roundMessage(outcome, attacker),
    });
    await this.deps.sleep(REVEAL_MS);

    if (score.player >= TARGET_SCORE || score.cpu >= TARGET_SCORE) {
      const winner: Side = score.player >= TARGET_SCORE ? 'player' : 'cpu';
      this.update({
        phase: 'match-over',
        winner,
        message: winner === 'player' ? 'あなたの勝ち！ 🎉' : 'CPU の勝ち… もう一回？',
      });
      return outcome;
    }

    this.update({ phase: 'janken', attacker: null, message: '次のじゃんけん！' });
    return outcome;
  }

  private update(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    this.onChange(this.state);
  }
}

function initialState(): GameState {
  return {
    phase: 'idle',
    score: { player: 0, cpu: 0 },
    attacker: null,
    janken: null,
    round: null,
    chant: null,
    message: '',
    winner: null,
  };
}

function undecidedMessage(reason: 'no-samples' | 'too-few-valid' | 'low-confidence'): string {
  switch (reason) {
    case 'no-samples':
      return '映像を取得できませんでした。もう一度';
    case 'too-few-valid':
      return 'どの方向か分かりませんでした（はっきり指さして！）';
    case 'low-confidence':
      return '自信のある判定ができませんでした。もう一度';
  }
}

function roundMessage(outcome: RoundOutcome, attacker: Side): string {
  switch (outcome) {
    case 'player-point':
      return '当たり！ あなたのポイント 🎯';
    case 'cpu-point':
      return '同じ方向を向いてしまった… CPU のポイント';
    case 'dodge':
      return attacker === 'player' ? 'かわされた！ 惜しい' : 'かわした！ セーフ 😌';
    case 'undecided':
      return '判定できませんでした';
  }
}
