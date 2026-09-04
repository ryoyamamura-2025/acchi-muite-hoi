import { isDomainLabel, type AnyLabel, type Domain } from '../ml/labels';
import type { ValidationStore } from './validationStore';
import type { ValidationSessionRecord } from './types';

export interface ValidationModelSnapshot {
  state: string;
  sharedDataEnabled: boolean;
  activeDatasetRevision: number;
}

export interface ValidationPrediction {
  label: AnyLabel;
  confidences: Readonly<Partial<Record<AnyLabel, number>>>;
}

export interface ValidationServiceDeps<TSource> {
  store: ValidationStore;
  getModelSnapshot(): ValidationModelSnapshot;
  predict(domain: Domain, source: TSource): Promise<ValidationPrediction | null>;
  now?: () => number;
  createId?: () => string;
}

/**
 * 明示的な検証試行だけを永続化する。
 * 通常推論・ゲーム推論からこのserviceを呼ばないことがログ境界になる。
 */
export class ValidationService<TSource> {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly deps: ValidationServiceDeps<TSource>) {
    this.now = deps.now ?? (() => Date.now());
    this.createId = deps.createId ?? createValidationSessionId;
  }

  async runTrial(
    domain: Domain,
    expectedLabel: AnyLabel,
    source: TSource,
  ): Promise<ValidationSessionRecord> {
    if (!isDomainLabel(domain, expectedLabel)) {
      throw new Error(`expectedLabel ${expectedLabel} is invalid for ${domain}`);
    }

    const before = this.deps.getModelSnapshot();
    requireReadySnapshot(before);

    const prediction = await this.deps.predict(domain, source);

    const after = this.deps.getModelSnapshot();
    requireReadySnapshot(after);
    if (
      before.sharedDataEnabled !== after.sharedDataEnabled ||
      before.activeDatasetRevision !== after.activeDatasetRevision
    ) {
      throw new Error('Validation中にActive Dataset条件が変更されたため記録しませんでした');
    }

    let predictedLabel: AnyLabel | null = null;
    let confidence: number | null = null;
    if (prediction) {
      if (!isDomainLabel(domain, prediction.label)) {
        throw new Error(`prediction label ${prediction.label} is invalid for ${domain}`);
      }
      predictedLabel = prediction.label;
      const rawConfidence = prediction.confidences[prediction.label];
      if (rawConfidence !== undefined) {
        if (!Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1) {
          throw new Error('prediction confidence must be between 0 and 1');
        }
        confidence = rawConfidence;
      }
    }

    const record: ValidationSessionRecord = {
      validationSessionId: this.createId(),
      timestamp: this.now(),
      sharedDataEnabled: before.sharedDataEnabled,
      domain,
      expectedLabel,
      predictedLabel,
      confidence,
      activeDatasetRevision: before.activeDatasetRevision,
    };
    validateRecord(record);
    await this.deps.store.put(record);
    return structuredClone(record);
  }

  async listTrials(): Promise<ValidationSessionRecord[]> {
    const records = await this.deps.store.list();
    return records.sort((a, b) => a.timestamp - b.timestamp);
  }

  async clearTrials(): Promise<void> {
    await this.deps.store.clear();
  }
}

function requireReadySnapshot(snapshot: ValidationModelSnapshot): void {
  if (snapshot.state !== 'ready') throw new Error('ValidationはClassifier ready時のみ実行できます');
  if (!Number.isInteger(snapshot.activeDatasetRevision) || snapshot.activeDatasetRevision < 0) {
    throw new Error('activeDatasetRevision is invalid');
  }
}

function validateRecord(record: ValidationSessionRecord): void {
  if (!record.validationSessionId) throw new Error('validationSessionId is required');
  if (!Number.isFinite(record.timestamp) || record.timestamp < 0) throw new Error('timestamp is invalid');
  if (!isDomainLabel(record.domain, record.expectedLabel)) throw new Error('expectedLabel is invalid');
  if (record.predictedLabel !== null && !isDomainLabel(record.domain, record.predictedLabel)) {
    throw new Error('predictedLabel is invalid');
  }
}

function createValidationSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `validation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
