import type { AnyLabel, Domain } from './labels';
import { isDomainLabel } from './labels';
import type { Sample, SampleKey } from './types';
import { makeSampleKey } from './types';
import {
  cosineSimilarity,
  createSimilarityCacheEntry,
  makeSimilarityPairKey,
  type SimilarityCacheEntry,
} from './similarity';

export interface SampleSelectorSettings {
  similarityThreshold: number;
  maxSamplesPerClass: number;
}

export interface SampleSelectorConfig {
  pointer: SampleSelectorSettings;
  face: SampleSelectorSettings;
}

export const DEFAULT_SAMPLE_SELECTOR_CONFIG: SampleSelectorConfig = {
  pointer: { similarityThreshold: 0.98, maxSamplesPerClass: 100 },
  face: { similarityThreshold: 0.98, maxSamplesPerClass: 100 },
};

export interface SampleSelectionResult {
  /** 選別後に残すべきclass全体。 */
  samples: Sample[];
  /** 今回の候補のうち最終的に残ったsample。 */
  acceptedCandidates: Sample[];
  /** similarity threshold以上のため破棄した候補。 */
  duplicateCandidates: Sample[];
  /** 100件上限維持のため削除対象になったsample。 */
  evictedSamples: Sample[];
  /** 選別後のclass内pair cache。破損・欠損時は再計算して補完する。 */
  cacheEntries: SimilarityCacheEntry[];
}

/**
 * 同一domain / labelの既存sampleと新規候補を、多様性を保ちながら最大件数へ収める。
 *
 * 通常経路では新規sample × 既存sampleだけsimilarityを計算する。上限超過時に
 * 最類似pairを探すため既存pair cacheが欠損していた場合のみ、欠損pairを再計算する。
 */
export function selectRepresentativeSamples(
  existingSamples: readonly Sample[],
  candidates: readonly Sample[],
  domain: Domain,
  label: AnyLabel,
  cachedEntries: readonly SimilarityCacheEntry[] = [],
  config: SampleSelectorConfig = DEFAULT_SAMPLE_SELECTOR_CONFIG,
): SampleSelectionResult {
  if (!isDomainLabel(domain, label)) {
    throw new Error(`domainとlabelが一致しません: ${domain}/${label}`);
  }

  const settings = config[domain];
  assertSettings(settings);
  if (existingSamples.length > settings.maxSamplesPerClass) {
    throw new Error(
      `existing samples exceed maxSamplesPerClass: ${existingSamples.length} > ${settings.maxSamplesPerClass}`,
    );
  }

  assertClassSamples(existingSamples, domain, label);
  assertClassSamples(candidates, domain, label);
  assertUniqueSampleKeys([...existingSamples, ...candidates]);

  const retained = [...existingSamples];
  const duplicateCandidates: Sample[] = [];
  const evictedSamples: Sample[] = [];
  const candidateKeys = new Set(candidates.map(sampleKey));

  const cache = new Map<string, SimilarityCacheEntry>();
  const initialKeys = new Set(existingSamples.map(sampleKey));
  for (const entry of cachedEntries) {
    if (
      initialKeys.has(entry.firstSampleKey) &&
      initialKeys.has(entry.secondSampleKey) &&
      entry.pairKey === makeSimilarityPairKey(entry.firstSampleKey, entry.secondSampleKey) &&
      Number.isFinite(entry.similarity) &&
      entry.similarity >= -1 &&
      entry.similarity <= 1
    ) {
      cache.set(entry.pairKey, entry);
    }
  }

  for (const candidate of candidates) {
    const candidateKey = sampleKey(candidate);
    const comparisons: SimilarityCacheEntry[] = [];
    let maxSimilarity = -Infinity;

    for (const current of retained) {
      const currentKey = sampleKey(current);
      const pairKey = makeSimilarityPairKey(candidateKey, currentKey);
      const cached = cache.get(pairKey);
      const entry =
        cached ??
        createSimilarityCacheEntry(
          candidateKey,
          currentKey,
          cosineSimilarity(candidate.feature, current.feature),
        );
      comparisons.push(entry);
      maxSimilarity = Math.max(maxSimilarity, entry.similarity);
    }

    if (retained.length > 0 && maxSimilarity >= settings.similarityThreshold) {
      duplicateCandidates.push(candidate);
      continue;
    }

    for (const entry of comparisons) cache.set(entry.pairKey, entry);
    retained.push(candidate);

    if (retained.length > settings.maxSamplesPerClass) {
      ensureCompleteCache(retained, cache);
      const closestPair = mostSimilarPair(cache, new Set(retained.map(sampleKey)));
      if (!closestPair) throw new Error('上限超過時の最類似sample pairを特定できませんでした');

      const byKey = new Map(retained.map((sample) => [sampleKey(sample), sample] as const));
      const first = byKey.get(closestPair.firstSampleKey);
      const second = byKey.get(closestPair.secondSampleKey);
      if (!first || !second) throw new Error('similarity cacheが現在のsample集合と一致しません');

      const evicted = olderSample(first, second);
      evictedSamples.push(evicted);
      const evictedKey = sampleKey(evicted);
      const index = retained.findIndex((sample) => sampleKey(sample) === evictedKey);
      retained.splice(index, 1);
      removeSampleFromCache(cache, evictedKey);
    }
  }

  const retainedKeys = new Set(retained.map(sampleKey));
  pruneCache(cache, retainedKeys);

  const acceptedCandidates = retained.filter((sample) => candidateKeys.has(sampleKey(sample)));
  return {
    samples: retained,
    acceptedCandidates,
    duplicateCandidates,
    evictedSamples,
    cacheEntries: [...cache.values()].sort((a, b) => a.pairKey.localeCompare(b.pairKey)),
  };
}

function ensureCompleteCache(
  samples: readonly Sample[],
  cache: Map<string, SimilarityCacheEntry>,
): void {
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const first = samples[i];
      const second = samples[j];
      const firstKey = sampleKey(first);
      const secondKey = sampleKey(second);
      const pairKey = makeSimilarityPairKey(firstKey, secondKey);
      if (cache.has(pairKey)) continue;
      cache.set(
        pairKey,
        createSimilarityCacheEntry(
          firstKey,
          secondKey,
          cosineSimilarity(first.feature, second.feature),
        ),
      );
    }
  }
}

function mostSimilarPair(
  cache: ReadonlyMap<string, SimilarityCacheEntry>,
  retainedKeys: ReadonlySet<SampleKey>,
): SimilarityCacheEntry | null {
  let best: SimilarityCacheEntry | null = null;
  for (const entry of cache.values()) {
    if (!retainedKeys.has(entry.firstSampleKey) || !retainedKeys.has(entry.secondSampleKey)) continue;
    if (
      best === null ||
      entry.similarity > best.similarity ||
      (entry.similarity === best.similarity && entry.pairKey < best.pairKey)
    ) {
      best = entry;
    }
  }
  return best;
}

function olderSample(a: Sample, b: Sample): Sample {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? a : b;
  // capturedAtが同一でも結果が実行環境依存にならないようsample keyで固定する。
  return sampleKey(a) < sampleKey(b) ? a : b;
}

function removeSampleFromCache(
  cache: Map<string, SimilarityCacheEntry>,
  key: SampleKey,
): void {
  for (const [pairKey, entry] of cache) {
    if (entry.firstSampleKey === key || entry.secondSampleKey === key) cache.delete(pairKey);
  }
}

function pruneCache(
  cache: Map<string, SimilarityCacheEntry>,
  retainedKeys: ReadonlySet<SampleKey>,
): void {
  for (const [pairKey, entry] of cache) {
    if (!retainedKeys.has(entry.firstSampleKey) || !retainedKeys.has(entry.secondSampleKey)) {
      cache.delete(pairKey);
    }
  }
}

function assertClassSamples(
  samples: readonly Sample[],
  domain: Domain,
  label: AnyLabel,
): void {
  for (const sample of samples) {
    if (sample.domain !== domain || sample.label !== label) {
      throw new Error(
        `selectorへ異なるclassのsampleが渡されました: expected ${domain}/${label}, actual ${sample.domain}/${sample.label}`,
      );
    }
  }
}

function assertUniqueSampleKeys(samples: readonly Sample[]): void {
  const seen = new Set<string>();
  for (const sample of samples) {
    const key = sampleKey(sample);
    if (seen.has(key)) throw new Error(`duplicate sample key: ${key}`);
    seen.add(key);
  }
}

function assertSettings(settings: SampleSelectorSettings): void {
  if (
    !Number.isFinite(settings.similarityThreshold) ||
    settings.similarityThreshold < -1 ||
    settings.similarityThreshold > 1
  ) {
    throw new Error(`invalid similarityThreshold: ${settings.similarityThreshold}`);
  }
  if (!Number.isInteger(settings.maxSamplesPerClass) || settings.maxSamplesPerClass < 1) {
    throw new Error(`invalid maxSamplesPerClass: ${settings.maxSamplesPerClass}`);
  }
}

function sampleKey(sample: Sample): SampleKey {
  return makeSampleKey(sample.sourceInstallationId, sample.id);
}
