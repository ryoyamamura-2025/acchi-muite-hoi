import type { ValidationStore } from '../../src/validation/validationStore';
import type { ValidationSessionRecord } from '../../src/validation/types';

export class MemoryValidationStore implements ValidationStore {
  private readonly records = new Map<string, ValidationSessionRecord>();

  async put(record: ValidationSessionRecord): Promise<void> {
    this.records.set(record.validationSessionId, structuredClone(record));
  }

  async list(): Promise<ValidationSessionRecord[]> {
    return structuredClone([...this.records.values()]);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
