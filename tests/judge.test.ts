import { describe, expect, it } from 'vitest';
import { judgeDirection, type JudgeSample } from '../src/game/judge';
import type { AnyLabel } from '../src/ml/labels';

function sample(label: AnyLabel, confidence = 1): JudgeSample {
  return { label, confidences: { [label]: confidence } };
}

describe('judgeDirection', () => {
  it('サンプルが無ければundecided', () => {
    expect(judgeDirection([])).toEqual({
      kind: 'undecided',
      reason: 'no-samples',
      total: 0,
      valid: 0,
    });
  });

  it('多数派の方向を採用する', () => {
    const result = judgeDirection([
      sample('right'),
      sample('right'),
      sample('right'),
      sample('up'),
    ]);
    expect(result).toMatchObject({
      kind: 'decided',
      direction: 'right',
      votes: 3,
      total: 4,
      valid: 4,
    });
  });

  it('Pointerのneutralはvalid frameから除外する', () => {
    const result = judgeDirection([
      sample('neutral'),
      sample('neutral'),
      sample('neutral'),
      sample('left'),
    ]);
    expect(result).toEqual({
      kind: 'undecided',
      reason: 'too-few-valid',
      total: 4,
      valid: 1,
    });
  });

  it('Faceのfrontもvalid frameから除外する', () => {
    const result = judgeDirection([
      sample('front'),
      sample('front'),
      sample('down'),
      sample('down'),
    ]);
    expect(result).toMatchObject({
      kind: 'decided',
      direction: 'down',
      total: 4,
      valid: 2,
    });
  });

  it('勝ち方向の平均信頼度が閾値未満ならlow-confidence', () => {
    const result = judgeDirection([sample('left', 0.4), sample('left', 0.4)]);
    expect(result).toEqual({
      kind: 'undecided',
      reason: 'low-confidence',
      total: 2,
      valid: 2,
    });
  });

  it('Pointer/Faceごとに渡された閾値を適用できる', () => {
    const samples = [sample('left', 0.4), sample('left', 0.4)];
    expect(judgeDirection(samples, { minConfidence: 0.3 })).toMatchObject({
      kind: 'decided',
      direction: 'left',
    });
  });

  it('票数が同じならconfidence合計が大きい方向を採用する', () => {
    const result = judgeDirection([sample('up', 0.6), sample('right', 1)]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'right' });
  });

  it('平均confidenceは勝者に投票したframeだけで計算する', () => {
    const result = judgeDirection([sample('right', 1), sample('right', 0.8), sample('up', 1)]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'right' });
    if (result.kind === 'decided') expect(result.confidence).toBeCloseTo(0.9);
  });

  it('minValidRatio=0でもnon-directionだけならdecidedにしない', () => {
    const result = judgeDirection([sample('front'), sample('front')], { minValidRatio: 0 });
    expect(result).toEqual({
      kind: 'undecided',
      reason: 'too-few-valid',
      total: 2,
      valid: 0,
    });
  });

  it('閾値は0〜1以外を拒否する', () => {
    expect(() => judgeDirection([sample('up')], { minConfidence: 1.1 })).toThrow();
    expect(() => judgeDirection([sample('up')], { minValidRatio: -0.1 })).toThrow();
  });
});
