import { FACE_LABELS, POINTER_LABELS } from '../ml/labels';
import type { ActiveIndex } from '../ml/types';
import type { DatabasePort } from './database';

export function createEmptyActiveIndex(revision = 0): ActiveIndex {
  return {
    revision,
    pointer: { up: [], right: [], down: [], left: [], neutral: [] },
    face: { up: [], right: [], down: [], left: [], front: [] },
  };
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
