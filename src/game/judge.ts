import { Direction, DIRECTIONS, ClassLabel, isDirection } from '../ml/labels';

/** 1 フレーム分の推論結果。 */
export interface JudgeSample {
  label: ClassLabel;
  confidences: Record<ClassLabel, number>;
}

export interface JudgeOptions {
  /** 勝ちラベルの平均信頼度の下限。 */
  minConfidence?: number;
  /** 方向を指していたフレームが全体に占める割合の下限。 */
  minValidRatio?: number;
}

export type JudgeResult =
  | {
      kind: 'decided';
      direction: Direction;
      confidence: number;
      votes: number;
      total: number;
    }
  | {
      kind: 'undecided';
      reason: 'no-samples' | 'too-few-valid' | 'low-confidence';
      total: number;
    };

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MIN_VALID_RATIO = 0.5;

/**
 * 「ほい！」の瞬間に集めた複数フレームから方向を 1 つ決める。
 *
 * 1 フレームだけ見ると手のブレやモーションブラーで揺れるため、
 * `neutral` を除いた多数決 + 平均信頼度の閾値で判定する。決めきれない場合は
 * `undecided` を返し、ゲーム側でやり直させる（誤判定で勝敗が付くより良い）。
 */
export function judgeDirection(samples: JudgeSample[], options: JudgeOptions = {}): JudgeResult {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minValidRatio = options.minValidRatio ?? DEFAULT_MIN_VALID_RATIO;
  const total = samples.length;

  if (total === 0) return { kind: 'undecided', reason: 'no-samples', total };

  const valid = samples.filter(
    (sample): sample is JudgeSample & { label: Direction } => isDirection(sample.label),
  );
  if (valid.length === 0 || valid.length / total < minValidRatio) {
    return { kind: 'undecided', reason: 'too-few-valid', total };
  }

  const votes: Record<Direction, number> = { up: 0, right: 0, down: 0, left: 0 };
  const confidenceSum: Record<Direction, number> = { up: 0, right: 0, down: 0, left: 0 };
  for (const sample of valid) {
    votes[sample.label] += 1;
    confidenceSum[sample.label] += sample.confidences[sample.label];
  }

  // 票数が同数のときは信頼度の合計が大きい方を採用する。
  const winner = DIRECTIONS.reduce<Direction>((best, candidate) => {
    if (votes[candidate] !== votes[best]) return votes[candidate] > votes[best] ? candidate : best;
    return confidenceSum[candidate] > confidenceSum[best] ? candidate : best;
  }, DIRECTIONS[0]);

  const confidence = confidenceSum[winner] / votes[winner];
  if (confidence < minConfidence) {
    return { kind: 'undecided', reason: 'low-confidence', total };
  }

  return { kind: 'decided', direction: winner, confidence, votes: votes[winner], total };
}
