import type { SampleKey } from './types';

export interface SimilarityCacheEntry {
  pairKey: string;
  firstSampleKey: SampleKey;
  secondSampleKey: SampleKey;
  similarity: number;
}

/** Float32特徴量同士のcosine similarity。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`feature dimension mismatch: ${a.length} !== ${b.length}`);
  }
  if (a.length === 0) throw new Error('feature vector is empty');

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / Math.sqrt(normA * normB);
  // 浮動小数点誤差で±1をわずかに越えないようにする。
  return Math.max(-1, Math.min(1, similarity));
}

/** sampleの順序に依存しないpair key。 */
export function makeSimilarityPairKey(a: SampleKey, b: SampleKey): string {
  if (a === b) throw new Error('同一sample同士のsimilarity pairは作成できません');
  const [first, second] = a < b ? [a, b] : [b, a];
  return `${first}\u0000${second}`;
}

export function createSimilarityCacheEntry(
  a: SampleKey,
  b: SampleKey,
  similarity: number,
): SimilarityCacheEntry {
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) {
    throw new Error(`invalid cosine similarity: ${similarity}`);
  }
  const [firstSampleKey, secondSampleKey] = a < b ? [a, b] : [b, a];
  return {
    pairKey: makeSimilarityPairKey(firstSampleKey, secondSampleKey),
    firstSampleKey,
    secondSampleKey,
    similarity,
  };
}
