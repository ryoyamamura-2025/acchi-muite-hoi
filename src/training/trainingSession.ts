import { DEFAULT_RUNTIME_TUNING } from '../config/tuning';
import { DatasetRepository } from '../data/datasetRepository';
import { SimilarityCacheRepository } from '../data/similarityCache';
import type { AnyLabel, Domain } from '../ml/labels';
import { isDomainLabel, isFaceLabel, isPointerLabel } from '../ml/labels';
import {
  DEFAULT_SAMPLE_SELECTOR_CONFIG,
  selectRepresentativeSamples,
  type SampleSelectorConfig,
} from '../ml/sampleSelector';
import type { InstallationId, Sample } from '../ml/types';
import { makeSampleKey } from '../ml/types';

export type TrainingState =
  | 'idle'
  | 'preparing'
  | 'capturing'
  | 'processing'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface TrainingStatus {
  state: TrainingState;
  domain: Domain | null;
  label: AnyLabel | null;
  captureSessionId: string | null;
  candidateCount: number;
  acceptedCount: number;
  errorMessage: string | null;
}

export interface TrainingSessionConfig {
  durationMs: number;
  candidateIntervalMs: number;
  stableLeadInMs: number;
  stableLeadOutMs: number;
  selector: SampleSelectorConfig;
}

export const DEFAULT_TRAINING_SESSION_CONFIG: TrainingSessionConfig = {
  durationMs: DEFAULT_RUNTIME_TUNING.training.durationMs,
  candidateIntervalMs: DEFAULT_RUNTIME_TUNING.training.candidateIntervalMs,
  stableLeadInMs: DEFAULT_RUNTIME_TUNING.training.stableLeadInMs,
  stableLeadOutMs: DEFAULT_RUNTIME_TUNING.training.stableLeadOutMs,
  selector: DEFAULT_SAMPLE_SELECTOR_CONFIG,
};

export interface TrainingSessionDeps {
  datasetRepository: DatasetRepository;
  similarityCacheRepository: SimilarityCacheRepository;
  installationId: InstallationId;
  captureFeature(signal: AbortSignal): Promise<Float32Array>;
  now?: () => number;
  timestamp?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  createId?: () => string;
  onStatusChanged?: (status: TrainingStatus) => void;
}

export type TrainingSessionResult =
  | {
      kind: 'completed';
      captureSessionId: string;
      candidateCount: number;
      acceptedCount: number;
      duplicateCount: number;
      evictedCount: number;
      totalClassSamples: number;
    }
  | {
      kind: 'cancelled';
      captureSessionId: string;
      candidateCount: number;
    }
  | {
      kind: 'error';
      captureSessionId: string;
      candidateCount: number;
      error: unknown;
    };

export class TrainingSession {
  private status: TrainingStatus = idleStatus();
  private controller: AbortController | null = null;
  private readonly config: TrainingSessionConfig;
  private readonly now: () => number;
  private readonly timestamp: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly createId: () => string;

  constructor(private readonly deps: TrainingSessionDeps, config: Partial<TrainingSessionConfig> = {}) {
    this.config = {
      ...DEFAULT_TRAINING_SESSION_CONFIG,
      ...config,
      selector: config.selector ?? DEFAULT_TRAINING_SESSION_CONFIG.selector,
    };
    assertConfig(this.config);
    this.now = deps.now ?? defaultNow;
    this.timestamp = deps.timestamp ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
    this.createId = deps.createId ?? createUuid;
  }

  getStatus(): TrainingStatus {
    return { ...this.status };
  }

  cancel(): boolean {
    if (!this.controller || this.status.state === 'saving') return false;
    this.controller.abort();
    if (this.status.state !== 'cancelled') this.update({ state: 'cancelled' });
    return true;
  }

  async start(domain: Domain, label: AnyLabel): Promise<TrainingSessionResult> {
    if (this.controller) throw new Error('Training session is already running');
    if (!isDomainLabel(domain, label)) {
      throw new Error(`domainとlabelが一致しません: ${domain}/${label}`);
    }

    const captureSessionId = this.createId();
    const controller = new AbortController();
    this.controller = controller;
    const candidates: Sample[] = [];

    this.setStatus({
      state: 'preparing',
      domain,
      label,
      captureSessionId,
      candidateCount: 0,
      acceptedCount: 0,
      errorMessage: null,
    });

    try {
      this.update({ state: 'capturing' });
      const startedAt = this.now();
      const stableEndOffset = this.config.durationMs - this.config.stableLeadOutMs;

      for (
        let offset = this.config.stableLeadInMs;
        offset <= stableEndOffset;
        offset += this.config.candidateIntervalMs
      ) {
        await this.sleepUntil(startedAt + offset, controller.signal);
        throwIfAborted(controller.signal);

        const feature = await this.deps.captureFeature(controller.signal);
        throwIfAborted(controller.signal);
        assertFeature(feature);

        candidates.push(
          createSample(
            domain,
            label,
            feature,
            this.timestamp(),
            captureSessionId,
            this.deps.installationId,
            this.createId(),
          ),
        );
        this.update({ candidateCount: candidates.length });
      }

      await this.sleepUntil(startedAt + this.config.durationMs, controller.signal);
      throwIfAborted(controller.signal);

      this.update({ state: 'processing' });
      const [existingSamples, cacheEntries] = await Promise.all([
        this.deps.datasetRepository.getLocalSamples({ domain, label }),
        this.deps.similarityCacheRepository.getClass(domain, label),
      ]);
      throwIfAborted(controller.signal);

      const selection = selectRepresentativeSamples(
        existingSamples,
        candidates,
        domain,
        label,
        cacheEntries,
        this.config.selector,
      );
      this.update({ acceptedCount: selection.acceptedCandidates.length });
      throwIfAborted(controller.signal);

      if (sampleSetChanged(existingSamples, selection.samples)) {
        this.update({ state: 'saving' });
        await this.deps.datasetRepository.commitLocalClassSelection(
          domain,
          label,
          selection.samples,
          selection.cacheEntries,
          this.deps.installationId,
        );
      }

      this.update({ state: 'completed' });
      return {
        kind: 'completed',
        captureSessionId,
        candidateCount: candidates.length,
        acceptedCount: selection.acceptedCandidates.length,
        duplicateCount: selection.duplicateCandidates.length,
        evictedCount: selection.evictedSamples.length,
        totalClassSamples: selection.samples.length,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.status.state !== 'cancelled') this.update({ state: 'cancelled' });
        return {
          kind: 'cancelled',
          captureSessionId,
          candidateCount: candidates.length,
        };
      }

      this.update({
        state: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: 'error',
        captureSessionId,
        candidateCount: candidates.length,
        error,
      };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async sleepUntil(target: number, signal: AbortSignal): Promise<void> {
    const remaining = target - this.now();
    if (remaining > 0) await this.sleep(remaining, signal);
  }

  private setStatus(status: TrainingStatus): void {
    this.status = status;
    this.deps.onStatusChanged?.(this.getStatus());
  }

  private update(patch: Partial<TrainingStatus>): void {
    this.setStatus({ ...this.status, ...patch });
  }
}

function createSample(
  domain: Domain,
  label: AnyLabel,
  feature: Float32Array,
  capturedAt: number,
  captureSessionId: string,
  sourceInstallationId: InstallationId,
  id: string,
): Sample {
  const base = {
    id,
    feature: new Float32Array(feature),
    capturedAt,
    captureSessionId,
    sourceInstallationId,
  };

  if (domain === 'pointer') {
    if (!isPointerLabel(label)) throw new Error(`invalid pointer label: ${label}`);
    return { ...base, domain, label };
  }

  if (!isFaceLabel(label)) throw new Error(`invalid face label: ${label}`);
  return { ...base, domain, label };
}

function sampleSetChanged(before: readonly Sample[], after: readonly Sample[]): boolean {
  if (before.length !== after.length) return true;
  const beforeKeys = new Set(
    before.map((sample) => makeSampleKey(sample.sourceInstallationId, sample.id)),
  );
  return after.some(
    (sample) => !beforeKeys.has(makeSampleKey(sample.sourceInstallationId, sample.id)),
  );
}

function assertFeature(feature: Float32Array): void {
  if (!(feature instanceof Float32Array) || feature.length === 0) {
    throw new Error('captureFeature must return a non-empty Float32Array');
  }
  for (const value of feature) {
    if (!Number.isFinite(value)) throw new Error('feature contains a non-finite value');
  }
}

function assertConfig(config: TrainingSessionConfig): void {
  if (!Number.isFinite(config.durationMs) || config.durationMs <= 0) {
    throw new Error('durationMs must be > 0');
  }
  if (!Number.isFinite(config.candidateIntervalMs) || config.candidateIntervalMs <= 0) {
    throw new Error('candidateIntervalMs must be > 0');
  }
  if (!Number.isFinite(config.stableLeadInMs) || config.stableLeadInMs < 0) {
    throw new Error('stableLeadInMs must be >= 0');
  }
  if (!Number.isFinite(config.stableLeadOutMs) || config.stableLeadOutMs < 0) {
    throw new Error('stableLeadOutMs must be >= 0');
  }
  if (config.stableLeadInMs + config.stableLeadOutMs >= config.durationMs) {
    throw new Error('stable capture window must have positive duration');
  }
}

function idleStatus(): TrainingStatus {
  return {
    state: 'idle',
    domain: null,
    label: null,
    captureSessionId: null,
    candidateCount: 0,
    acceptedCount: 0,
    errorMessage: null,
  };
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('training session cancelled'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('training session cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('training session cancelled');
}

function createUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
