import type { AnyLabel, Domain } from '../ml/labels';
import { isDomainLabel } from '../ml/labels';
import type { SimilarityCacheEntry } from '../ml/similarity';
import type { Sample } from '../ml/types';
import type { DatabasePort } from './database';
import { STORE_NAMES } from './database';

export interface DatasetQuery {
  domain?: Domain;
  label?: AnyLabel;
  sourceInstallationId?: string;
}

export class DatasetRepository {
  constructor(private readonly db: DatabasePort) {}

  async getLocalSamples(query: DatasetQuery = {}): Promise<Sample[]> {
    return this.db.getSamples(STORE_NAMES.localSamples, query);
  }

  async getImportedSamples(query: DatasetQuery = {}): Promise<Sample[]> {
    return this.db.getSamples(STORE_NAMES.importedSamples, query);
  }

  /** 1学習session分を1回のDB transactionで保存するための入口。 */
  async commitLocalSamples(
    samples: readonly Sample[],
    installationId: string,
  ): Promise<void> {
    assertSamples(samples);
    for (const sample of samples) {
      if (sample.sourceInstallationId !== installationId) {
        throw new Error('Local sampleのsourceInstallationIdが現在のinstallationIdと一致しません');
      }
    }
    await this.db.putSamples(STORE_NAMES.localSamples, samples);
  }

  /**
   * 学習session後の1 class全体とsimilarity cacheを同一transactionで確定する。
   * selectorによる上限削除もこの置換に含め、中途半端な保存状態を残さない。
   */
  async commitLocalClassSelection(
    domain: Domain,
    label: AnyLabel,
    samples: readonly Sample[],
    cacheEntries: readonly SimilarityCacheEntry[],
    installationId: string,
  ): Promise<void> {
    if (!isDomainLabel(domain, label)) {
      throw new Error(`domainとlabelが一致しません: ${domain}/${label}`);
    }
    assertSamples(samples);
    for (const sample of samples) {
      if (sample.domain !== domain || sample.label !== label) {
        throw new Error('Local class selectionに異なるclassのsampleが含まれています');
      }
      if (sample.sourceInstallationId !== installationId) {
        throw new Error('Local sampleのsourceInstallationIdが現在のinstallationIdと一致しません');
      }
    }
    assertCacheEntries(cacheEntries);
    await this.db.commitLocalClassSelection(domain, label, samples, cacheEntries);
  }

  async commitImportedSamples(samples: readonly Sample[]): Promise<void> {
    assertSamples(samples);
    await this.db.putSamples(STORE_NAMES.importedSamples, samples);
  }

  /** Phase 5のsame-source再Importで使用するatomic replacement。 */
  async replaceImportedSource(
    sourceInstallationId: string,
    samples: readonly Sample[],
  ): Promise<void> {
    assertSamples(samples);
    if (samples.some((sample) => sample.sourceInstallationId !== sourceInstallationId)) {
      throw new Error('置換対象と異なるsourceInstallationIdのsampleが含まれています');
    }
    await this.db.replaceImportedSource(sourceInstallationId, samples);
  }

  async clearLocalDataset(): Promise<void> {
    await this.db.clearSampleStore(STORE_NAMES.localSamples);
  }

  async clearImportedDataset(): Promise<void> {
    await this.db.clearSampleStore(STORE_NAMES.importedSamples);
  }
}

function assertSamples(samples: readonly Sample[]): void {
  for (const sample of samples) {
    if (!sample.id || !sample.captureSessionId || !sample.sourceInstallationId) {
      throw new Error('Sample metadataが不足しています');
    }
    if (!isDomainLabel(sample.domain, sample.label)) {
      throw new Error(`domainとlabelが一致しません: ${sample.domain}/${sample.label}`);
    }
    if (!(sample.feature instanceof Float32Array)) {
      throw new Error('Sample featureはFloat32Arrayである必要があります');
    }
    if (!Number.isFinite(sample.capturedAt)) {
      throw new Error('capturedAtが不正です');
    }
  }
}

function assertCacheEntries(entries: readonly SimilarityCacheEntry[]): void {
  for (const entry of entries) {
    if (
      !entry.pairKey ||
      !entry.firstSampleKey ||
      !entry.secondSampleKey ||
      entry.firstSampleKey === entry.secondSampleKey ||
      !Number.isFinite(entry.similarity) ||
      entry.similarity < -1 ||
      entry.similarity > 1
    ) {
      throw new Error('invalid similarity cache entry');
    }
  }
}
