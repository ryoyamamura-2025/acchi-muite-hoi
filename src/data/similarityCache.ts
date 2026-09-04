import type { AnyLabel, Domain } from '../ml/labels';
import type { SimilarityCacheEntry } from '../ml/similarity';
import type { DatabasePort } from './database';

/** similarity cacheは派生データ。欠損・破損時はselector側で特徴量から再構築できる。 */
export class SimilarityCacheRepository {
  constructor(private readonly db: DatabasePort) {}

  async getClass(domain: Domain, label: AnyLabel): Promise<SimilarityCacheEntry[]> {
    const entries = await this.db.getSimilarityCache(domain, label);
    return entries.filter(isValidEntry);
  }

  async replaceClass(
    domain: Domain,
    label: AnyLabel,
    entries: readonly SimilarityCacheEntry[],
  ): Promise<void> {
    if (!entries.every(isValidEntry)) throw new Error('invalid similarity cache entry');
    await this.db.setSimilarityCache(domain, label, entries);
  }

  async clearClass(domain: Domain, label: AnyLabel): Promise<void> {
    await this.db.clearSimilarityCache(domain, label);
  }
}

function isValidEntry(entry: SimilarityCacheEntry): boolean {
  return (
    Boolean(entry.pairKey) &&
    Boolean(entry.firstSampleKey) &&
    Boolean(entry.secondSampleKey) &&
    entry.firstSampleKey !== entry.secondSampleKey &&
    Number.isFinite(entry.similarity) &&
    entry.similarity >= -1 &&
    entry.similarity <= 1
  );
}
