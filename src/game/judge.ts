import { DIRECTIONS, isDirection, type AnyLabel, type Direction } from '../ml/labels';
import type { UndecidedReason } from './types';

/** Pointer / Faceどちらでも使える1フレーム分の推論結果。 */
export interface JudgeSample {
  label: AnyLabel;
  confidences: Readonly<Partial<Record<AnyLabel, number>>>;
}

export interface JudgeOptions {
  /** 勝ち方向へ投票したフレームの平均信頼度の下限。 */
  minConfidence?: number;
  /** Directionラベルだったフレームが全体に占める割合の下限。 */
  minValidRatio?: number;
}

export type JudgeResult =
  | {
      kind: 'decided';
      direction: Direction;
      confidence: number;
      votes: number;
      total: number;
      valid: number;
    }
  | {
      kind: 'undecided';
      reason: UndecidedReason;
      total: number;
      valid: number;
    };

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_VALID_RATIO = 0.5;

/**
 * 「ほい！」直後の複数フレームから方向を1つ決める。
 * Pointerのneutral / FaceのfrontはDirectionではないためvalid frameから除外する。
 */
export function judgeDirection(
  samples: readonly JudgeSample[],
  options: JudgeOptions = {},
): JudgeResult {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minValidRatio = options.minValidRatio ?? DEFAULT_MIN_VALID_RATIO;
  assertRatio(minConfidence, 'minConfidence');
  assertRatio(minValidRatio, 'minValidRatio');

  const total = samples.length;
  if (total === 0) return { kind: 'undecided', reason: 'no-samples', total, valid: 0 };

  const valid = samples.filter(
    (sample): sample is JudgeSample & { label: Direction } => isDirection(sample.label),
  );
  if (valid.length === 0 || valid.length / total < minValidRatio) {
    return { kind: 'undecided', reason: 'too-few-valid', total, valid: valid.length };
  }

  const votes: Record<Direction, number> = { up: 0, right: 0, down: 0, left: 0 };
  const confidenceSum: Record<Direction, number> = { up: 0, right: 0, down: 0, left: 0 };
  for (const sample of valid) {
    const confidence = sample.confidences[sample.label] ?? 0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    votes[sample.label] += 1;
    confidenceSum[sample.label] += confidence;
  }

  const winner = DIRECTIONS.reduce<Direction>((best, candidate) => {
    if (votes[candidate] !== votes[best]) return votes[candidate] > votes[best] ? candidate : best;
    if (confidenceSum[candidate] !== confidenceSum[best]) {
      return confidenceSum[candidate] > confidenceSum[best] ? candidate : best;
    }
    return best;
  }, DIRECTIONS[0]);

  if (votes[winner] === 0) {
    return { kind: 'undecided', reason: 'low-confidence', total, valid: valid.length };
  }

  const confidence = confidenceSum[winner] / votes[winner];
  if (confidence < minConfidence) {
    return { kind: 'undecided', reason: 'low-confidence', total, valid: valid.length };
  }

  return {
    kind: 'decided',
    direction: winner,
    confidence,
    votes: votes[winner],
    total,
    valid: valid.length,
  };
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}
