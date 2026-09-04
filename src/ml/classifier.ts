import * as tf from '@tensorflow/tfjs';
import * as knnClassifier from '@tensorflow-models/knn-classifier';
import {
  CLASS_LABELS,
  ClassLabel,
  MIN_SAMPLES_PER_CLASS,
  emptyConfidences,
  isClassLabel,
} from './labels';

export interface Prediction {
  label: ClassLabel;
  confidences: Record<ClassLabel, number>;
}

export type SampleCounts = Record<ClassLabel, number>;

/** 近傍数。KNN 側で `min(k, サンプル総数)` にクランプされるので少数サンプルでも安全。 */
const K = 5;

/**
 * MobileNet の特徴量に対する KNN 分類器のラッパ。
 * サンプルを足した瞬間に反映されるので「学習ボタンを押した直後に効く」体験になる。
 */
export class PoseClassifier {
  private knn = knnClassifier.create();

  /**
   * `feature` の所有権は移らない（KNN 側は正規化したコピーを保持する）。
   * 呼び出し側が dispose すること。
   */
  addExample(feature: tf.Tensor2D, label: ClassLabel): void {
    this.knn.addExample(feature, label);
  }

  async predict(feature: tf.Tensor2D): Promise<Prediction | null> {
    if (this.total() === 0) return null;

    const result = await this.knn.predictClass(feature, K);
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
    for (const label of CLASS_LABELS) {
      counts[label] = raw[label] ?? 0;
    }
    return counts;
  }

  total(): number {
    // KNN の getNumExamples() は private なのでクラス別カウントから求める。
    return Object.values(this.counts()).reduce((sum, count) => sum + count, 0);
  }

  /** 全クラスが最低サンプル数に達しているか。ゲーム開始の条件。 */
  isReady(): boolean {
    const counts = this.counts();
    return CLASS_LABELS.every((label) => counts[label] >= MIN_SAMPLES_PER_CLASS);
  }

  /** 足りていないクラスの一覧（UI の警告用）。 */
  missingClasses(): ClassLabel[] {
    const counts = this.counts();
    return CLASS_LABELS.filter((label) => counts[label] < MIN_SAMPLES_PER_CLASS);
  }

  clearClass(label: ClassLabel): void {
    // 未知ラベルを渡すと KNN 側が throw するのでガードする。
    if (this.counts()[label] > 0) this.knn.clearClass(label);
  }

  clearAll(): void {
    this.knn.clearAllClasses();
  }

  /** 保存用。返り値のテンソルは KNN が保持しているものなので dispose してはいけない。 */
  exportDataset(): Record<string, tf.Tensor2D> {
    return this.knn.getClassifierDataset();
  }

  /** 復元用。渡したテンソルの所有権は KNN に移る。 */
  importDataset(dataset: Record<string, tf.Tensor2D>): void {
    this.knn.setClassifierDataset(dataset);
  }

  dispose(): void {
    this.knn.dispose();
  }
}
