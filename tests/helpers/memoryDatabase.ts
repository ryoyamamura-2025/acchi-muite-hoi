import type {
  DatabasePort,
  SampleFilter,
  SampleStoreName,
} from '../../src/data/database';
import { STORE_NAMES } from '../../src/data/database';
import type { ActiveIndex, Sample } from '../../src/ml/types';
import { makeSampleKey } from '../../src/ml/types';

export class MemoryDatabase implements DatabasePort {
  private readonly meta = new Map<string, unknown>();
  private readonly local = new Map<string, Sample>();
  private readonly imported = new Map<string, Sample>();
  private activeIndex: ActiveIndex | undefined;

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    this.meta.set(key, value);
  }

  async deleteMeta(key: string): Promise<void> {
    this.meta.delete(key);
  }

  async getSamples(store: SampleStoreName, filter: SampleFilter = {}): Promise<Sample[]> {
    const source = this.mapFor(store);
    return [...source.values()].filter((sample) => {
      if (filter.domain && sample.domain !== filter.domain) return false;
      if (filter.label && sample.label !== filter.label) return false;
      if (
        filter.sourceInstallationId &&
        sample.sourceInstallationId !== filter.sourceInstallationId
      ) {
        return false;
      }
      return true;
    });
  }

  async putSamples(store: SampleStoreName, samples: readonly Sample[]): Promise<void> {
    const target = this.mapFor(store);
    for (const sample of samples) {
      target.set(makeSampleKey(sample.sourceInstallationId, sample.id), cloneSample(sample));
    }
  }

  async clearSampleStore(store: SampleStoreName): Promise<void> {
    this.mapFor(store).clear();
  }

  async replaceImportedSource(
    sourceInstallationId: string,
    samples: readonly Sample[],
  ): Promise<void> {
    const next = new Map(this.imported);
    for (const [key, sample] of next) {
      if (sample.sourceInstallationId === sourceInstallationId) next.delete(key);
    }
    for (const sample of samples) {
      next.set(makeSampleKey(sample.sourceInstallationId, sample.id), cloneSample(sample));
    }
    this.imported.clear();
    for (const [key, sample] of next) this.imported.set(key, sample);
  }

  async getActiveIndex(): Promise<ActiveIndex | undefined> {
    return this.activeIndex ? structuredClone(this.activeIndex) : undefined;
  }

  async setActiveIndex(index: ActiveIndex): Promise<void> {
    this.activeIndex = structuredClone(index);
  }

  async clearActiveIndex(): Promise<void> {
    this.activeIndex = undefined;
  }

  async clearDatasetState(): Promise<void> {
    this.local.clear();
    this.imported.clear();
    this.activeIndex = undefined;
  }

  async resetAll(): Promise<void> {
    await this.clearDatasetState();
    this.meta.clear();
  }

  private mapFor(store: SampleStoreName): Map<string, Sample> {
    return store === STORE_NAMES.localSamples ? this.local : this.imported;
  }
}

function cloneSample(sample: Sample): Sample {
  return { ...sample, feature: new Float32Array(sample.feature) } as Sample;
}
