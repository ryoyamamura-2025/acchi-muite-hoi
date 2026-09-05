export interface DomainTuningSettings {
  k: number;
  confidenceThreshold: number;
  minValidRatio: number;
  similarityThreshold: number;
}

export interface TrainingTuningSettings {
  durationMs: number;
  candidateIntervalMs: number;
  stableLeadInMs: number;
  stableLeadOutMs: number;
}

export interface GameTuningSettings {
  /** 「ほい！」後に複数推論を集める判定窓。Phase 8で実機調整する。 */
  judgeWindowMs: number;
}

export interface RuntimeTuningSettings {
  pointer: DomainTuningSettings;
  face: DomainTuningSettings;
  training: TrainingTuningSettings;
  game: GameTuningSettings;
}

/**
 * Phase 8の実機調整値を一箇所に集約する。
 * ここにある値は設計上の初期値であり、実機計測結果を正解として更新する。
 */
export const DEFAULT_RUNTIME_TUNING: RuntimeTuningSettings = {
  pointer: {
    k: 5,
    confidenceThreshold: 0.6,
    minValidRatio: 0.5,
    similarityThreshold: 0.98,
  },
  face: {
    k: 5,
    confidenceThreshold: 0.6,
    minValidRatio: 0.5,
    similarityThreshold: 0.98,
  },
  training: {
    durationMs: 5000,
    candidateIntervalMs: 300,
    stableLeadInMs: 600,
    stableLeadOutMs: 600,
  },
  game: {
    judgeWindowMs: 500,
  },
};
