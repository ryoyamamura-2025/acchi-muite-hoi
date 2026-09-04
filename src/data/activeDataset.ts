import {
  FACE_LABELS,
  MIN_ACTIVE_SAMPLES_PER_CLASS,
  POINTER_LABELS,
  type FaceLabel,
  type PointerLabel,
} from '../ml/labels';
import {
  DEFAULT_SAMPLE_SELECTOR_CONFIG,
  selectRepresentativeSamples,
  type SampleSelectorConfig,
} from '../ml/sampleSelector';
import type { ActiveIndex, Sample, SampleKey } from '../ml/types';
import { makeSampleKey } from '../ml/types';
import type { DatabasePort } from './database';
import { DatasetRepository } from './datasetRepository';

export function createEmptyActiveIndex(revision = 0): ActiveIndex {
  return {
    revision,
    pointer: { up: [], right: [], down: [], left: [], neutral: [] },
    face: { up: [], right: [], down: [], left: [], front: [] },
  };
}

export interface MissingTrainingClasses {
  pointer: PointerLabel[];
  face: FaceLabel[];
}

export interface ResolvedActiveSamples {
  pointer: Sample[];
  face: Sample[];
}

export class ActiveDatasetRepository {
  constructor(private readonly db: DatabasePort) {}

  async load(): Promise<ActiveIndex> {
    return (await this.db.getActiveIndex()) ?? createEmptyActiveIndex();
  }

  async save(index: ActiveIndex): Promise<void> {
    assertActiveIndex(index);
    await this.db.setActiveIndex(index);
  }

  async clear(): Promise<void> {
    await this.db.clearActiveIndex();
  }
}

/**
 * Shared OFFならLocalのみ、ONならLocal+Importedを候補にし、各class最大100件へ再選抜する。
 * sampleの由来は並び順へ使わず、sample keyのみで決定的に並べる。
 */
export async function rebuildActiveDataset(
  datasetRepository: DatasetRepository,
  activeRepository: ActiveDatasetRepository,
  sharedDataEnabled: boolean,
  selectorConfig: SampleSelectorConfig = DEFAULT_SAMPLE_SELECTOR_CONFIG,
): Promise<ActiveIndex> {
  const [current, localSamples, importedSamples] = await Promise.all([
    activeRepository.load(),
    datasetRepository.getLocalSamples(),
    sharedDataEnabled ? datasetRepository.getImportedSamples() : Promise.resolve([]),
  ]);

  const pool = mergeCandidatePool(localSamples, importedSamples);
  const next = createEmptyActiveIndex(current.revision + 1);

  for (const label of POINTER_LABELS) {
    const candidates = pool
      .filter((sample) => sample.domain === 'pointer' && sample.label === label)
      .sort(compareSampleKey);
    const selection = selectRepresentativeSamples(
      [],
      candidates,
      'pointer',
      label,
      [],
      selectorConfig,
    );
    next.pointer[label] = selection.samples.map(sampleKey);
  }

  for (const label of FACE_LABELS) {
    const candidates = pool
      .filter((sample) => sample.domain === 'face' && sample.label === label)
      .sort(compareSampleKey);
    const selection = selectRepresentativeSamples([], candidates, 'face', label, [], selectorConfig);
    next.face[label] = selection.samples.map(sampleKey);
  }

  await activeRepository.save(next);
  return next;
}

/** ActiveIndexの参照先をLocal/Imported実データへ解決する。 */
export async function resolveActiveSamples(
  index: ActiveIndex,
  datasetRepository: DatasetRepository,
): Promise<ResolvedActiveSamples> {
  assertActiveIndex(index);
  const [localSamples, importedSamples] = await Promise.all([
    datasetRepository.getLocalSamples(),
    datasetRepository.getImportedSamples(),
  ]);
  const byKey = new Map<SampleKey, Sample>();
  for (const sample of mergeCandidatePool(localSamples, importedSamples)) {
    byKey.set(sampleKey(sample), sample);
  }

  const pointer: Sample[] = [];
  const face: Sample[] = [];

  for (const label of POINTER_LABELS) {
    for (const key of index.pointer[label]) {
      const sample = requireSample(byKey, key);
      if (sample.domain !== 'pointer' || sample.label !== label) {
        throw new Error(`Active Index参照先がpointer/${label}と一致しません: ${key}`);
      }
      pointer.push(sample);
    }
  }

  for (const label of FACE_LABELS) {
    for (const key of index.face[label]) {
      const sample = requireSample(byKey, key);
      if (sample.domain !== 'face' || sample.label !== label) {
        throw new Error(`Active Index参照先がface/${label}と一致しません: ${key}`);
      }
      face.push(sample);
    }
  }

  return { pointer, face };
}

export function canPlayWithActiveDataset(index: ActiveIndex): boolean {
  const missing = getMissingTrainingClasses(index);
  return missing.pointer.length === 0 && missing.face.length === 0;
}

export function getMissingTrainingClasses(index: ActiveIndex): MissingTrainingClasses {
  assertActiveIndex(index);
  return {
    pointer: POINTER_LABELS.filter(
      (label) => index.pointer[label].length < MIN_ACTIVE_SAMPLES_PER_CLASS,
    ),
    face: FACE_LABELS.filter((label) => index.face[label].length < MIN_ACTIVE_SAMPLES_PER_CLASS),
  };
}

function mergeCandidatePool(
  localSamples: readonly Sample[],
  importedSamples: readonly Sample[],
): Sample[] {
  const byKey = new Map<SampleKey, Sample>();
  for (const sample of [...localSamples, ...importedSamples]) {
    const key = sampleKey(sample);
    if (!byKey.has(key)) byKey.set(key, sample);
  }
  return [...byKey.values()];
}

function compareSampleKey(a: Sample, b: Sample): number {
  return sampleKey(a).localeCompare(sampleKey(b));
}

function sampleKey(sample: Sample): SampleKey {
  return makeSampleKey(sample.sourceInstallationId, sample.id);
}

function requireSample(byKey: ReadonlyMap<SampleKey, Sample>, key: SampleKey): Sample {
  const sample = byKey.get(key);
  if (!sample) throw new Error(`Active Indexが存在しないsampleを参照しています: ${key}`);
  return sample;
}

function assertActiveIndex(index: ActiveIndex): void {
  if (!Number.isInteger(index.revision) || index.revision < 0) {
    throw new Error('Active Dataset revisionが不正です');
  }

  for (const label of POINTER_LABELS) assertUnique(index.pointer[label], `pointer/${label}`);
  for (const label of FACE_LABELS) assertUnique(index.face[label], `face/${label}`);
}

function assertUnique(keys: readonly string[], name: string): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Active Indexに重複sample keyがあります: ${name}`);
  }
}
