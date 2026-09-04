import * as tf from '@tensorflow/tfjs';
import * as knnClassifier from '@tensorflow-models/knn-classifier';
import { DEFAULT_RUNTIME_TUNING } from '../config/tuning';
import {
  CLASS_LABELS,
  ClassLabel,
  FACE_LABELS,
  FaceLabel,
  MIN_SAMPLES_PER_CLASS,
  POINTER_LABELS,
  PointerLabel,
  emptyConfidences,
  isClassLabel,
  isFaceLabel,
  isPointerLabel,
} from './labels';
import type { Sample } from './types';

export interface Prediction {
  label: ClassLabel;
  confidences: Record<ClassLabel, number>;
}

export type SampleCounts = Record<ClassLabel, number>;

export interface DomainPrediction<L extends string> {
  label: L;
  confidences: Record<L, number>;
}

export type PointerPrediction = DomainPrediction<PointerLabel>;
export type FacePrediction = DomainPrediction<FaceLabel>;
export type PointerSampleCounts = Record<PointerLabel, number>;
export type FaceSampleCounts = Record<FaceLabel, number>;

export interface DomainClassifierSettings {
  k: number;
  confidenceThreshold: number;
  minValidRatio: number;
}

export interface ClassifierConfig {
  pointer: DomainClassifierSettings;
  face: DomainClassifierSettings;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  pointer: {
    k: DEFAULT_RUNTIME_TUNING.pointer.k,
    confidenceThreshold: DEFAULT_RUNTIME_TUNING.pointer.confidenceThreshold,
    minValidRatio: DEFAULT_RUNTIME_TUNING.pointer.minValidRatio,
  },
  face: {
    k: DEFAULT_RUNTIME_TUNING.face.k,
    confidenceThreshold: DEFAULT_RUNTIME_TUNING.face.confidenceThreshold,
    minValidRatio: DEFAULT_RUNTIME_TUNING.face.minValidRatio,
  },
};

export interface DomainClassifier<L extends string> {
  rebuild(samples: readonly Sample[]): void;
  predict(feature: tf.Tensor2D): Promise<DomainPrediction<L> | null>;
  counts(): Record<L, number>;
  total(): number;
  dispose(): void;
}

class KnnDomainClassifier<L extends string> implements DomainClassifier<L> {
  private knn = knnClassifier.create();

  constructor(
    private readonly domain: 'pointer' | 'face',
    private readonly labels: readonly L[],
    private readonly isLabel: (value: string) => value is L,
    private readonly featureDim: number,
    private readonly k: number,
  ) {
    if (!Number.isInteger(featureDim) || featureDim <= 0) {
      throw new Error(`invalid featureDim: ${featureDim}`);
    }
    if (!Number.isInteger(k) || k <= 0) throw new Error(`invalid k: ${k}`);
  }

  rebuild(samples: readonly Sample[]): void {
    const next = knnClassifier.create();
    try {
      for (const sample of samples) {
        if (sample.domain !== this.domain || !this.isLabel(sample.label)) {
          throw new Error(
            `classifierへ異なるdomain/labelのsampleが渡されました: expected ${this.domain}, actual ${sample.domain}/${sample.label}`,
          );
        }
        if (sample.feature.length !== this.featureDim) {
          throw new Error(
            `featureDim mismatch: expected ${this.featureDim}, actual ${sample.feature.length}`,
          );
        }

        const tensor = tf.tensor2d(sample.feature, [1, this.featureDim]);
        try {
          next.addExample(tensor, sample.label);
        } finally {
          tensor.dispose();
        }
      }
    } catch (error) {
      next.dispose();
      throw error;
    }

    this.knn.dispose();
    this.knn = next;
  }

  async predict(feature: tf.Tensor2D): Promise<DomainPrediction<L> | null> {
    if (this.total() === 0) return null;
    if (feature.shape.length !== 2 || feature.shape[0] !== 1 || feature.shape[1] !== this.featureDim) {
      throw new Error(
        `prediction feature shape mismatch: expected [1, ${this.featureDim}], actual [${feature.shape.join(', ')}]`,
      );
    }

    const result = await this.knn.predictClass(feature, this.k);
    if (!this.isLabel(result.label)) return null;

    const confidences = this.emptyCounts();
    for (const [label, value] of Object.entries(result.confidences)) {
      if (this.isLabel(label)) confidences[label] = value;
    }
    return { label: result.label, confidences };
  }

  counts(): Record<L, number> {
    const raw = this.knn.getClassExampleCount();
    const counts = this.emptyCounts();
    for (const label of this.labels) counts[label] = raw[label] ?? 0;
    return counts;
  }

  total(): number {
    const counts = this.counts();
    let total = 0;
    for (const label of this.labels) total += counts[label];
    return total;
  }

  dispose(): void {
    this.knn.dispose();
  }

  private emptyCounts(): Record<L, number> {
    return Object.fromEntries(this.labels.map((label) => [label, 0])) as Record<L, number>;
  }
}

export class PointerClassifier extends KnnDomainClassifier<PointerLabel> {
  constructor(featureDim: number, k = DEFAULT_CLASSIFIER_CONFIG.pointer.k) {
    super('pointer', POINTER_LABELS, isPointerLabel, featureDim, k);
  }
}

export class FaceClassifier extends KnnDomainClassifier<FaceLabel> {
  constructor(featureDim: number, k = DEFAULT_CLASSIFIER_CONFIG.face.k) {
    super('face', FACE_LABELS, isFaceLabel, featureDim, k);
  }
}

/**
 * Phase 4移行中の旧Pointer-only runtime互換クラス。
 * 新Application APIへの切替完了後に削除する。
 */
export class PoseClassifier {
  private knn = knnClassifier.create();

  addExample(feature: tf.Tensor2D, label: ClassLabel): void {
    this.knn.addExample(feature, label);
  }

  async predict(feature: tf.Tensor2D): Promise<Prediction | null> {
    if (this.total() === 0) return null;

    const result = await this.knn.predictClass(feature, DEFAULT_CLASSIFIER_CONFIG.pointer.k);
    if (!isClassLabel(result.label)) return null;

    const confidences = emptyConfidences();
    for (const [label, value] of Object.entries(result.confidences)) {
      if (isClassLabel(label)) confidences[label] = value;
    }
    return { label: result.label, confidences };
  }

  counts(): SampleCounts {
    const raw = this.knn.getClassExampleCount();
    const counts = { up: 0, right: 0, down: 0, left: 0, neutral: 0 } satisfies SampleCounts;
    for (const label of CLASS_LABELS) counts[label] = raw[label] ?? 0;
    return counts;
  }

  total(): number {
    return Object.values(this.counts()).reduce((sum, count) => sum + count, 0);
  }

  isReady(): boolean {
    const counts = this.counts();
    return CLASS_LABELS.every((label) => counts[label] >= MIN_SAMPLES_PER_CLASS);
  }

  missingClasses(): ClassLabel[] {
    const counts = this.counts();
    return CLASS_LABELS.filter((label) => counts[label] < MIN_SAMPLES_PER_CLASS);
  }

  clearClass(label: ClassLabel): void {
    if (this.counts()[label] > 0) this.knn.clearClass(label);
  }

  clearAll(): void {
    this.knn.clearAllClasses();
  }

  exportDataset(): Record<string, tf.Tensor2D> {
    return this.knn.getClassifierDataset();
  }

  importDataset(dataset: Record<string, tf.Tensor2D>): void {
    this.knn.setClassifierDataset(dataset);
  }

  dispose(): void {
    this.knn.dispose();
  }
}
