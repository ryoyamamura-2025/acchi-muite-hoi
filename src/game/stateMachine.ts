import { DEFAULT_RUNTIME_TUNING } from '../config/tuning';
import { DEFAULT_CLASSIFIER_CONFIG } from '../ml/classifier';
import type { Domain, Direction } from '../ml/labels';
import { judgeDirection, type JudgeOptions, type JudgeSample } from './judge';
import { createBrowserGameSound, type GameSoundPort } from './sound';
import {
  oppositeSide,
  sideFromFirstAttacker,
  type GameState as CoreGameState,
  type MatchOptions,
  type Side,
  type TargetScore,
} from './types';

export type {
  FirstAttacker,
  GamePhase,
  GameState as MatchGameState,
  HandOutcome,
  HandResultView,
  MatchOptions,
  Side,
  TargetScore,
  UndecidedReason,
} from './types';

export {
  Game,
  HAND_META,
  TARGET_SCORE,
  randomHand,
  type GameState,
  type Hand,
} from './legacyStateMachine';

export interface MatchGameDeps {
  collect(domain: Domain, durationMs: number): Promise<JudgeSample[]>;
  sleep(ms: number): Promise<void>;
  randomDirection(): Direction;
  sound?: GameSoundPort;
}

export interface GameTiming {
  preparingMs: number;
  attackReadyMs: number;
  chantMs: number;
  captureMs: number;
  resultMs: number;
}

export interface MatchGameConfig {
  timing?: Partial<GameTiming>;
  pointerJudge?: JudgeOptions;
  faceJudge?: JudgeOptions;
}

export const DEFAULT_GAME_TIMING: GameTiming = {
  preparingMs: 800,
  attackReadyMs: 900,
  chantMs: 1200,
  captureMs: DEFAULT_RUNTIME_TUNING.game.judgeWindowMs,
  resultMs: 1800,
};

export const TARGET_SCORES: readonly TargetScore[] = [1, 3];

export class MatchGame {
  private state: CoreGameState = initialState();
  private running = false;
  private runToken = 0;
  private readonly timing: GameTiming;
  private readonly pointerJudge: Required<JudgeOptions>;
  private readonly faceJudge: Required<JudgeOptions>;
  private readonly sound: GameSoundPort;

  constructor(
    private readonly deps: MatchGameDeps,
    private readonly onChange: (state: CoreGameState) => void,
    config: MatchGameConfig = {},
  ) {
    this.timing = { ...DEFAULT_GAME_TIMING, ...config.timing };
    assertTiming(this.timing);
    this.pointerJudge = {
      minConfidence:
        config.pointerJudge?.minConfidence ?? DEFAULT_CLASSIFIER_CONFIG.pointer.confidenceThreshold,
      minValidRatio:
        config.pointerJudge?.minValidRatio ?? DEFAULT_CLASSIFIER_CONFIG.pointer.minValidRatio,
    };
    this.faceJudge = {
      minConfidence:
        config.faceJudge?.minConfidence ?? DEFAULT_CLASSIFIER_CONFIG.face.confidenceThreshold,
      minValidRatio:
        config.faceJudge?.minValidRatio ?? DEFAULT_CLASSIFIER_CONFIG.face.minValidRatio,
    };
    this.sound = deps.sound ?? createBrowserGameSound();
  }

  getState(): CoreGameState {
    return cloneState(this.state);
  }

  isRunning(): boolean {
    return this.running;
  }

  reset(): void {
    this.runToken += 1;
    this.running = false;
    this.state = initialState();
    this.emit();
  }

  cancel(): void {
    this.reset();
  }

  async startMatch(options: MatchOptions): Promise<void> {
    if (this.running) throw new Error('match is already running');
    assertMatchOptions(options);

    // startMatchはユーザー操作から同期的に呼ばれるため、ここでAudioContextを解錠する。
    this.sound.unlock();

    const first = sideFromFirstAttacker(options.firstAttacker);
    const token = ++this.runToken;
    this.running = true;
    this.state = {
      phase: 'preparing',
      score: { player: 0, cpu: 0 },
      targetScore: options.targetScore,
      attacker: first,
      defender: oppositeSide(first),
      pointStarter: first,
      pointNumber: 1,
      cpuDirection: null,
      playerDirection: null,
      result: null,
      chant: null,
      message: '対戦準備中…',
      winner: null,
    };
    this.emit();
    this.sound.play('start');

    try {
      await this.deps.sleep(this.timing.preparingMs);
      while (this.isCurrentRun(token) && this.state.winner === null) {
        await this.runHand(token);
      }
    } catch (error) {
      if (this.isCurrentRun(token)) {
        this.state = {
          ...this.state,
          phase: 'idle',
          chant: null,
          cpuDirection: null,
          playerDirection: null,
          result: null,
          message: 'ゲーム処理でエラーが発生しました',
        };
        this.emit();
      }
      throw error;
    } finally {
      if (this.runToken === token) this.running = false;
    }
  }

  private async runHand(token: number): Promise<void> {
    const attacker = this.requireAttacker();
    const domain: Domain = attacker === 'player' ? 'pointer' : 'face';
    const judgeOptions = domain === 'pointer' ? this.pointerJudge : this.faceJudge;

    this.update({
      phase: attacker === 'player' ? 'player-attack' : 'cpu-attack',
      defender: oppositeSide(attacker),
      cpuDirection: null,
      playerDirection: null,
      result: null,
      chant: null,
      message:
        attacker === 'player'
          ? 'あなたが攻撃。指さす方向を決めてください'
          : 'CPUが攻撃。顔を向ける準備をしてください',
    });
    await this.deps.sleep(this.timing.attackReadyMs);
    if (!this.isCurrentRun(token)) return;

    const pendingCpuDirection = this.deps.randomDirection();
    this.update({
      phase: 'chant',
      chant: 'あっち向いて…',
      cpuDirection: null,
      playerDirection: null,
      result: null,
      message: attacker === 'player' ? '指さす準備！' : '顔を向ける準備！',
    });
    this.sound.play('chant');
    await this.deps.sleep(this.timing.chantMs);
    if (!this.isCurrentRun(token)) return;

    this.update({
      phase: 'judging',
      chant: 'ほい！',
      cpuDirection: null,
      playerDirection: null,
      result: null,
      message: '判定中…',
    });
    this.sound.play('hoi');
    const samples = await this.deps.collect(domain, this.timing.captureMs);
    if (!this.isCurrentRun(token)) return;

    const judged = judgeDirection(samples, judgeOptions);
    if (judged.kind === 'undecided') {
      this.update({
        phase: 'retry',
        chant: null,
        cpuDirection: null,
        playerDirection: null,
        result: {
          playerDirection: null,
          cpuDirection: null,
          outcome: 'undecided',
          confidence: null,
          undecidedReason: judged.reason,
        },
        message: undecidedMessage(judged.reason),
      });
      this.sound.play('retry');
      await this.deps.sleep(this.timing.resultMs);
      return;
    }

    const playerDirection = judged.direction;
    const matched = playerDirection === pendingCpuDirection;
    const outcome = matched
      ? attacker === 'player'
        ? 'player-point'
        : 'cpu-point'
      : 'miss';
    const score = { ...this.state.score };
    if (outcome === 'player-point') score.player += 1;
    if (outcome === 'cpu-point') score.cpu += 1;

    this.update({
      phase: 'result',
      score,
      chant: null,
      cpuDirection: pendingCpuDirection,
      playerDirection,
      result: {
        playerDirection,
        cpuDirection: pendingCpuDirection,
        outcome,
        confidence: judged.confidence,
        undecidedReason: null,
      },
      message: resultMessage(outcome, attacker),
    });
    this.sound.play(outcome);
    await this.deps.sleep(this.timing.resultMs);
    if (!this.isCurrentRun(token)) return;

    if (!matched) {
      const nextAttacker = oppositeSide(attacker);
      this.update({
        phase: nextAttacker === 'player' ? 'player-attack' : 'cpu-attack',
        attacker: nextAttacker,
        defender: oppositeSide(nextAttacker),
        cpuDirection: null,
        playerDirection: null,
        result: null,
        message: nextAttacker === 'player' ? '攻守交代。あなたが攻撃' : '攻守交代。CPUが攻撃',
      });
      return;
    }

    const winner = winnerFor(score, this.requireTargetScore());
    if (winner) {
      this.update({
        phase: 'match-over',
        winner,
        chant: null,
        message: winner === 'player' ? 'あなたの勝ち！ 🎉' : 'CPUの勝ち！',
      });
      this.sound.play(winner === 'player' ? 'win' : 'lose');
      return;
    }

    const currentStarter = this.requirePointStarter();
    const nextStarter = oppositeSide(currentStarter);
    this.update({
      phase: 'preparing',
      pointNumber: this.state.pointNumber + 1,
      pointStarter: nextStarter,
      attacker: nextStarter,
      defender: oppositeSide(nextStarter),
      cpuDirection: null,
      playerDirection: null,
      result: null,
      message: `次のポイント。${nextStarter === 'player' ? 'あなた' : 'CPU'}から攻撃`,
    });
  }

  private requireAttacker(): Side {
    if (!this.state.attacker) throw new Error('attacker is not initialized');
    return this.state.attacker;
  }

  private requirePointStarter(): Side {
    if (!this.state.pointStarter) throw new Error('pointStarter is not initialized');
    return this.state.pointStarter;
  }

  private requireTargetScore(): TargetScore {
    if (!this.state.targetScore) throw new Error('targetScore is not initialized');
    return this.state.targetScore;
  }

  private isCurrentRun(token: number): boolean {
    return this.running && this.runToken === token;
  }

  private update(patch: Partial<CoreGameState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    this.onChange(cloneState(this.state));
  }
}

function initialState(): CoreGameState {
  return {
    phase: 'idle',
    score: { player: 0, cpu: 0 },
    targetScore: null,
    attacker: null,
    defender: null,
    pointStarter: null,
    pointNumber: 0,
    cpuDirection: null,
    playerDirection: null,
    result: null,
    chant: null,
    message: '',
    winner: null,
  };
}

function cloneState(state: CoreGameState): CoreGameState {
  return {
    ...state,
    score: { ...state.score },
    result: state.result ? { ...state.result } : null,
  };
}

function assertMatchOptions(options: MatchOptions): void {
  if (options.firstAttacker !== 'player-first' && options.firstAttacker !== 'cpu-first') {
    throw new Error('firstAttacker must be player-first or cpu-first');
  }
  if (options.targetScore !== 1 && options.targetScore !== 3) {
    throw new Error('targetScore must be 1 or 3');
  }
}

function assertTiming(timing: GameTiming): void {
  for (const [key, value] of Object.entries(timing)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid game timing: ${key}`);
  }
  if (timing.captureMs <= 0) throw new Error('captureMs must be > 0');
}

function winnerFor(score: Record<Side, number>, targetScore: TargetScore): Side | null {
  if (score.player >= targetScore) return 'player';
  if (score.cpu >= targetScore) return 'cpu';
  return null;
}

function undecidedMessage(reason: 'no-samples' | 'too-few-valid' | 'low-confidence'): string {
  switch (reason) {
    case 'no-samples':
      return '映像を取得できませんでした。同じ手をもう一度';
    case 'too-few-valid':
      return '方向を決められませんでした。同じ攻守でもう一度';
    case 'low-confidence':
      return '判定の確信度が足りません。同じ攻守でもう一度';
  }
}

function resultMessage(
  outcome: 'player-point' | 'cpu-point' | 'miss',
  attacker: Side,
): string {
  if (outcome === 'player-point') return '方向一致！ あなたのポイント 🎯';
  if (outcome === 'cpu-point') return '方向一致！ CPUのポイント';
  return attacker === 'player' ? 'かわされた！ 攻守交代' : 'かわした！ 攻守交代';
}
