import { describe, expect, it } from 'vitest';
import { JudgeSample, judgeDirection } from '../src/game/judge';
import { ClassLabel, emptyConfidences } from '../src/ml/labels';
import { judgeJanken } from '../src/game/stateMachine';

/** 指定ラベルを confidence 付きで返すヘルパ。 */
function sample(label: ClassLabel, confidence = 1): JudgeSample {
  const confidences = emptyConfidences();
  confidences[label] = confidence;
  return { label, confidences };
}

describe('judgeDirection', () => {
  it('サンプルが無ければ undecided', () => {
    expect(judgeDirection([])).toEqual({ kind: 'undecided', reason: 'no-samples', total: 0 });
  });

  it('多数派の方向を採用する', () => {
    const result = judgeDirection([
      sample('right'),
      sample('right'),
      sample('right'),
      sample('up'),
    ]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'right', votes: 3, total: 4 });
  });

  it('neutral が過半数なら too-few-valid', () => {
    const result = judgeDirection([
      sample('neutral'),
      sample('neutral'),
      sample('neutral'),
      sample('left'),
    ]);
    expect(result).toEqual({ kind: 'undecided', reason: 'too-few-valid', total: 4 });
  });

  it('neutral は多数決の対象から除外される', () => {
    const result = judgeDirection([sample('neutral'), sample('down'), sample('down')]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'down', votes: 2 });
  });

  it('平均信頼度が閾値未満なら low-confidence', () => {
    const result = judgeDirection([sample('left', 0.4), sample('left', 0.4)]);
    expect(result).toEqual({ kind: 'undecided', reason: 'low-confidence', total: 2 });
  });

  it('閾値はオプションで変えられる', () => {
    const samples = [sample('left', 0.4), sample('left', 0.4)];
    expect(judgeDirection(samples, { minConfidence: 0.3 })).toMatchObject({
      kind: 'decided',
      direction: 'left',
    });
  });

  it('同数のときは信頼度の合計が大きい方を採用する', () => {
    const result = judgeDirection([sample('up', 0.6), sample('right', 1)]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'right' });
  });

  it('平均信頼度は勝者に投票したフレームだけで計算する', () => {
    // right が 2 票（1.0 と 0.8）、up が 1 票。平均は 0.9 になるべき。
    const result = judgeDirection([sample('right', 1), sample('right', 0.8), sample('up', 1)]);
    expect(result).toMatchObject({ kind: 'decided', direction: 'right' });
    if (result.kind === 'decided') expect(result.confidence).toBeCloseTo(0.9);
  });
});

describe('judgeJanken', () => {
  it('同じ手はあいこ', () => {
    expect(judgeJanken('rock', 'rock')).toBe('draw');
  });

  it('グーはチョキに勝つ', () => {
    expect(judgeJanken('rock', 'scissors')).toBe('win');
  });

  it('チョキはグーに負ける', () => {
    expect(judgeJanken('scissors', 'rock')).toBe('lose');
  });

  it('パーはグーに勝ち、チョキに負ける', () => {
    expect(judgeJanken('paper', 'rock')).toBe('win');
    expect(judgeJanken('paper', 'scissors')).toBe('lose');
  });
});

describe('judgeDirection のエッジケース', () => {
  it('minValidRatio を 0 にしても neutral だけなら decided にしない', () => {
    const result = judgeDirection([sample('neutral'), sample('neutral')], { minValidRatio: 0 });
    expect(result).toEqual({ kind: 'undecided', reason: 'too-few-valid', total: 2 });
  });
});
