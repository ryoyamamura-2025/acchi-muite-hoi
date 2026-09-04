import type * as tf from '@tensorflow/tfjs';
import {
  ActiveDatasetRepository,
  canPlayWithActiveDataset,
  createEmptyActiveIndex,
  getMissingTrainingClasses,
  rebuildActiveDataset,
  resolveActiveSamples,
  type MissingTrainingClasses,
} from '../data/activeDataset';
import type { DatabasePort } from '../data/database';
import { DatasetRepository } from '../data/datasetRepository';
import {
  DATASET_VERSION,
  META_KEYS,
  ensureDatasetCompatibility,
  getDataRevision,
  getOrCreateInstallationId,
} from '../data/installation';
import { SimilarityCacheRepository } from '../data/similarityCache';
import {
  FaceClassifier,
  PointerClassifier,
  type DomainClassifier,
  type FacePrediction,
  type PointerPrediction,
} from '../ml/classifier';
import type { FeatureExtractor } from '../ml/featureExtractor';
import type { AnyLabel, Domain, FaceLabel, PointerLabel } from '../ml/labels';
import {
  DEFAULT_SAMPLE_SELECTOR_CONFIG,
  type SampleSelectorConfig,
} from '../ml/sampleSelector';
import type { ActiveIndex, InstallationId } from '../ml/types';
import {
  TrainingSession,
  type TrainingSessionConfig,
  type TrainingSessionResult,
  type TrainingStatus,
} from '../training/trainingSession';

export type ModelServiceState = 'initializing' | 'rebuilding-classifiers' | 'ready' | 'error';

export interface ModelServiceStatus {
  state: ModelServiceState;
  sharedDataEnabled: boolean;
  activeDatasetRevision: number;
  errorMessage: string | null;
}

export type InferenceSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

export interface ModelServiceDeps {
  db: DatabasePort;
  /** Pointer/Faceの両方で共有する唯一のFeatureExtractor。 */
  extractor: FeatureExtractor;
  pointerClassifier?: DomainClassifier<PointerLabel>;
  faceClassifier?: DomainClassifier<FaceLabel>;
  selectorConfig?: SampleSelectorConfig;
  trainingConfig?: Partial<TrainingSessionConfig>;
  onStatusChanged?: (status: ModelServiceStatus) => void;
  onTrainingStatusChanged?: (status: TrainingStatus) => void;
}

export class ModelService {
  private readonly datasetRepository: DatasetRepository;
  private readonly activeRepository: ActiveDatasetRepository;
  private readonly similarityCacheRepository: SimilarityCacheRepository;
  private readonly pointerClassifier: DomainClassifier<PointerLabel>;
  private readonly faceClassifier: DomainClassifier<FaceLabel>;
  private readonly selectorConfig: SampleSelectorConfig;
  private readonly trainingConfig: Partial<TrainingSessionConfig>;

  private installationId: InstallationId | null = null;
  private activeIndex: ActiveIndex = createEmptyActiveIndex();
  private sharedDataEnabled = false;
  private status: ModelServiceStatus = {
    state: 'initializing',
    sharedDataEnabled: false,
    activeDatasetRevision: 0,
    errorMessage: null,
  };
  private trainingSession: TrainingSession | null = null;
  private trainingStatus: TrainingStatus = idleTrainingStatus();

  constructor(private readonly deps: ModelServiceDeps) {
    this.datasetRepository = new DatasetRepository(deps.db);
    this.activeRepository = new ActiveDatasetRepository(deps.db);
    this.similarityCacheRepository = new SimilarityCacheRepository(deps.db);
    this.pointerClassifier =
      deps.pointerClassifier ?? new PointerClassifier(deps.extractor.featureDim, 5);
    this.faceClassifier = deps.faceClassifier ?? new FaceClassifier(deps.extractor.featureDim, 5);
    this.selectorConfig = deps.selectorConfig ?? DEFAULT_SAMPLE_SELECTOR_CONFIG;
    this.trainingConfig = deps.trainingConfig ?? {};
  }

  async initialize(): Promise<void> {
    this.setStatus({ state: 'initializing', errorMessage: null });
    try {
      await ensureDatasetCompatibility(this.deps.db, {
        datasetVersion: DATASET_VERSION,
        extractorName: this.deps.extractor.name,
        featureDim: this.deps.extractor.featureDim,
      });
      this.installationId = await getOrCreateInstallationId(this.deps.db);

      const storedShared = await this.deps.db.getMeta<boolean>(META_KEYS.sharedDataEnabled);
      this.sharedDataEnabled = storedShared ?? false;
      if (storedShared === undefined) {
        await this.deps.db.setMeta(META_KEYS.sharedDataEnabled, false);
      }

      const [index, dataRevision, activeSourceRevision, activeShared] = await Promise.all([
        this.activeRepository.load(),
        getDataRevision(this.deps.db),
        this.deps.db.getMeta<number>(META_KEYS.activeSourceRevision),
        this.deps.db.getMeta<boolean>(META_KEYS.activeSharedDataEnabled),
      ]);

      const activeIsCurrent =
        index.revision > 0 &&
        activeSourceRevision === dataRevision &&
        activeShared === this.sharedDataEnabled;

      if (activeIsCurrent) {
        try {
          await this.rebuildClassifiersFromIndex(index);
          this.activeIndex = index;
          this.setStatus({
            state: 'ready',
            sharedDataEnabled: this.sharedDataEnabled,
            activeDatasetRevision: index.revision,
            errorMessage: null,
          });
          return;
        } catch {
          // 壊れた/欠損したActive参照は元Datasetから再生成する。
        }
      }

      await this.rebuildActiveAndClassifiers(dataRevision);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  getStatus(): ModelServiceStatus {
    return { ...this.status };
  }

  getTrainingStatus(): TrainingStatus {
    return { ...this.trainingStatus };
  }

  getActiveIndex(): ActiveIndex {
    return structuredClone(this.activeIndex);
  }

  isSharedDataEnabled(): boolean {
    return this.sharedDataEnabled;
  }

  canPlay(): boolean {
    return this.status.state === 'ready' && canPlayWithActiveDataset(this.activeIndex);
  }

  getMissingTrainingClasses(): MissingTrainingClasses {
    return getMissingTrainingClasses(this.activeIndex);
  }

  async setSharedDataEnabled(enabled: boolean): Promise<void> {
    this.requireInitialized();
    if (this.trainingSession) throw new Error('学習session中はShared設定を変更できません');
    if (enabled === this.sharedDataEnabled && this.status.state === 'ready') return;

    await this.deps.db.setMeta(META_KEYS.sharedDataEnabled, enabled);
    this.sharedDataEnabled = enabled;
    this.setStatus({ sharedDataEnabled: enabled });

    try {
      await this.rebuildActiveAndClassifiers(await getDataRevision(this.deps.db));
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async predictPointer(source: InferenceSource): Promise<PointerPrediction | null> {
    this.requireInferenceReady();
    const feature = this.deps.extractor.infer(source);
    try {
      return await this.pointerClassifier.predict(feature);
    } finally {
      feature.dispose();
    }
  }

  async predictFace(source: InferenceSource): Promise<FacePrediction | null> {
    this.requireInferenceReady();
    const feature = this.deps.extractor.infer(source);
    try {
      return await this.faceClassifier.predict(feature);
    } finally {
      feature.dispose();
    }
  }

  async startTraining(
    domain: Domain,
    label: AnyLabel,
    sourceProvider: () => InferenceSource,
  ): Promise<TrainingSessionResult> {
    this.requireInitialized();
    if (this.status.state !== 'ready') throw new Error('Classifier再構築中は学習を開始できません');
    if (this.trainingSession) throw new Error('Training session is already running');
    if (!this.installationId) throw new Error('installationId is not initialized');

    const session = new TrainingSession(
      {
        datasetRepository: this.datasetRepository,
        similarityCacheRepository: this.similarityCacheRepository,
        installationId: this.installationId,
        captureFeature: (signal) => this.captureFeature(sourceProvider(), signal),
        onStatusChanged: (status) => {
          this.trainingStatus = status;
          this.deps.onTrainingStatusChanged?.(this.getTrainingStatus());
        },
      },
      {
        ...this.trainingConfig,
        selector: this.selectorConfig,
      },
    );
    this.trainingSession = session;

    try {
      const result = await session.start(domain, label);
      if (result.kind === 'completed' && (result.acceptedCount > 0 || result.evictedCount > 0)) {
        const nextDataRevision = (await getDataRevision(this.deps.db)) + 1;
        await this.deps.db.setMeta(META_KEYS.dataRevision, nextDataRevision);
        try {
          await this.rebuildActiveAndClassifiers(nextDataRevision);
        } catch (error) {
          this.fail(error);
        }
      }
      return result;
    } finally {
      if (this.trainingSession === session) this.trainingSession = null;
    }
  }

  cancelTraining(): boolean {
    return this.trainingSession?.cancel() ?? false;
  }

  async refreshFromDatasets(): Promise<void> {
    this.requireInitialized();
    if (this.trainingSession) throw new Error('学習session中はDatasetを再構築できません');
    try {
      await this.rebuildActiveAndClassifiers(await getDataRevision(this.deps.db));
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  dispose(): void {
    this.trainingSession?.cancel();
    this.pointerClassifier.dispose();
    this.faceClassifier.dispose();
    this.deps.extractor.dispose();
  }

  private async rebuildActiveAndClassifiers(dataRevision: number): Promise<void> {
    this.setStatus({ state: 'rebuilding-classifiers', errorMessage: null });
    const index = await rebuildActiveDataset(
      this.datasetRepository,
      this.activeRepository,
      this.sharedDataEnabled,
      this.selectorConfig,
    );
    await this.rebuildClassifiersFromIndex(index);

    await Promise.all([
      this.deps.db.setMeta(META_KEYS.activeSourceRevision, dataRevision),
      this.deps.db.setMeta(META_KEYS.activeSharedDataEnabled, this.sharedDataEnabled),
    ]);

    this.activeIndex = index;
    this.setStatus({
      state: 'ready',
      sharedDataEnabled: this.sharedDataEnabled,
      activeDatasetRevision: index.revision,
      errorMessage: null,
    });
  }

  private async rebuildClassifiersFromIndex(index: ActiveIndex): Promise<void> {
    const active = await resolveActiveSamples(index, this.datasetRepository);
    this.pointerClassifier.rebuild(active.pointer);
    this.faceClassifier.rebuild(active.face);
  }

  private async captureFeature(source: InferenceSource, signal: AbortSignal): Promise<Float32Array> {
    if (signal.aborted) throw new Error('training session cancelled');
    const tensor: tf.Tensor2D = this.deps.extractor.infer(source);
    try {
      const values = await tensor.data();
      if (signal.aborted) throw new Error('training session cancelled');
      return new Float32Array(values);
    } finally {
      tensor.dispose();
    }
  }

  private requireInitialized(): void {
    if (!this.installationId) throw new Error('ModelService is not initialized');
  }

  private requireInferenceReady(): void {
    this.requireInitialized();
    if (this.status.state !== 'ready' || this.trainingSession) {
      throw new Error('推論はClassifier ready時のみ実行できます');
    }
  }

  private setStatus(patch: Partial<ModelServiceStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onStatusChanged?.(this.getStatus());
  }

  private fail(error: unknown): void {
    this.setStatus({
      state: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function idleTrainingStatus(): TrainingStatus {
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
