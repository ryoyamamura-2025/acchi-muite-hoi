import type { ModelService, InferenceSource } from './modelService';
import { ValidationService } from '../validation/validationService';
import {
  createIndexedDbValidationStore,
  type ValidationStore,
} from '../validation/validationStore';

/**
 * ModelServiceの現在のActive条件とPointer/Face classifierをValidationへ接続する。
 * UIはこの境界より下のKNN / IndexedDBを意識しない。
 */
export function createModelValidationService(
  modelService: ModelService,
  store: ValidationStore = createIndexedDbValidationStore(),
): ValidationService<InferenceSource> {
  return new ValidationService<InferenceSource>({
    store,
    getModelSnapshot: () => modelService.getStatus(),
    predict: async (domain, source) => {
      if (domain === 'pointer') return modelService.predictPointer(source);
      return modelService.predictFace(source);
    },
  });
}
