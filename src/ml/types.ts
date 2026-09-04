import type { Domain, FaceLabel, PointerLabel } from './labels';

export type SampleId = string;
export type InstallationId = string;
export type CaptureSessionId = string;
export type SampleKey = string;

interface SampleBase {
  id: SampleId;
  feature: Float32Array;
  capturedAt: number;
  captureSessionId: CaptureSessionId;
  sourceInstallationId: InstallationId;
}

export interface PointerSample extends SampleBase {
  domain: 'pointer';
  label: PointerLabel;
}

export interface FaceSample extends SampleBase {
  domain: 'face';
  label: FaceLabel;
}

/** Local / Imported Datasetが保持する特徴量サンプル。 */
export type Sample = PointerSample | FaceSample;

export type LabelForDomain<D extends Domain> = D extends 'pointer' ? PointerLabel : FaceLabel;

export interface ActiveIndex {
  revision: number;
  pointer: Record<PointerLabel, SampleKey[]>;
  face: Record<FaceLabel, SampleKey[]>;
}

/**
 * sourceInstallationIdとsample idを組み合わせ、端末間で衝突しないActive Index用キーにする。
 * sourceInstallationId / idはいずれも生成時にUUIDを使う。
 */
export function makeSampleKey(sourceInstallationId: InstallationId, id: SampleId): SampleKey {
  return `${sourceInstallationId}:${id}`;
}
