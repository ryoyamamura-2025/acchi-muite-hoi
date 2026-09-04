/** 学習させる 4 方向。ゲームの判定に使えるのはこの 4 つだけ。 */
export type Direction = 'up' | 'right' | 'down' | 'left';

/** 分類器が扱う全ラベル。`neutral` は「何も指さしていない」状態。 */
export type ClassLabel = Direction | 'neutral';

export const DIRECTIONS = ['up', 'right', 'down', 'left'] as const satisfies readonly Direction[];

export const CLASS_LABELS = [...DIRECTIONS, 'neutral'] as const satisfies readonly ClassLabel[];

export interface ClassMeta {
  ja: string;
  icon: string;
  hint: string;
}

/**
 * カメラ映像は鏡表示（`transform: scaleX(-1)`）で、特徴抽出側でも同じように
 * 左右反転している。そのため「右」は常に *画面に映った自分から見た右* を指す。
 */
export const CLASS_META: Record<ClassLabel, ClassMeta> = {
  up: { ja: '上', icon: '☝️', hint: '上を指さす' },
  right: { ja: '右', icon: '👉', hint: '画面の右を指さす' },
  down: { ja: '下', icon: '👇', hint: '下を指さす' },
  left: { ja: '左', icon: '👈', hint: '画面の左を指さす' },
  neutral: { ja: '待機', icon: '🙂', hint: '何も指さしていない状態' },
};

/** これを下回るクラスがあるうちはゲームを始めさせない。 */
export const MIN_SAMPLES_PER_CLASS = 20;

export function isDirection(label: string): label is Direction {
  return (DIRECTIONS as readonly string[]).includes(label);
}

export function isClassLabel(label: string): label is ClassLabel {
  return (CLASS_LABELS as readonly string[]).includes(label);
}

export function emptyConfidences(): Record<ClassLabel, number> {
  return { up: 0, right: 0, down: 0, left: 0, neutral: 0 };
}
