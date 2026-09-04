/** 方向判定に共通で使う4方向。 */
export type Direction = 'up' | 'right' | 'down' | 'left';

/** 学習・推論の用途。PointerとFaceは別Classifierとして扱う。 */
export type Domain = 'pointer' | 'face';

/** Pointer classifierのラベル。 */
export type PointerLabel = Direction | 'neutral';

/** Face classifierのラベル。 */
export type FaceLabel = Direction | 'front';

export type DomainLabel<D extends Domain> = D extends 'pointer' ? PointerLabel : FaceLabel;
export type AnyLabel = PointerLabel | FaceLabel;

export const DIRECTIONS = ['up', 'right', 'down', 'left'] as const satisfies readonly Direction[];
export const POINTER_LABELS = [...DIRECTIONS, 'neutral'] as const satisfies readonly PointerLabel[];
export const FACE_LABELS = [...DIRECTIONS, 'front'] as const satisfies readonly FaceLabel[];

export const DOMAIN_LABELS = {
  pointer: POINTER_LABELS,
  face: FACE_LABELS,
} as const satisfies { pointer: readonly PointerLabel[]; face: readonly FaceLabel[] };

/** Active Dataset上で各クラスに必要な対戦解禁サンプル数。 */
export const MIN_ACTIVE_SAMPLES_PER_CLASS = 10;

export function isDirection(label: string): label is Direction {
  return (DIRECTIONS as readonly string[]).includes(label);
}

export function isPointerLabel(label: string): label is PointerLabel {
  return (POINTER_LABELS as readonly string[]).includes(label);
}

export function isFaceLabel(label: string): label is FaceLabel {
  return (FACE_LABELS as readonly string[]).includes(label);
}

export function isDomainLabel<D extends Domain>(domain: D, label: string): label is DomainLabel<D> {
  return domain === 'pointer' ? isPointerLabel(label) : isFaceLabel(label);
}

/*
 * Phase 1では既存UIを全面改修しないため、旧Pointer-only UI向けexportを残す。
 * Application APIへ接続し直すPhase 4以降で削除する。
 */
export type ClassLabel = PointerLabel;
export const CLASS_LABELS = POINTER_LABELS;

export interface ClassMeta {
  ja: string;
  icon: string;
  hint: string;
}

export const CLASS_META: Record<ClassLabel, ClassMeta> = {
  up: { ja: '上', icon: '☝️', hint: '上を指さす' },
  right: { ja: '右', icon: '👉', hint: '画面の右を指さす' },
  down: { ja: '下', icon: '👇', hint: '下を指さす' },
  left: { ja: '左', icon: '👈', hint: '画面の左を指さす' },
  neutral: { ja: '待機', icon: '🙂', hint: '何も指さしていない状態' },
};

/** 旧UI/旧Classifierの一時互換値。新しい対戦可否判定では使用しない。 */
export const MIN_SAMPLES_PER_CLASS = 20;

export function isClassLabel(label: string): label is ClassLabel {
  return isPointerLabel(label);
}

export function emptyConfidences(): Record<ClassLabel, number> {
  return { up: 0, right: 0, down: 0, left: 0, neutral: 0 };
}
