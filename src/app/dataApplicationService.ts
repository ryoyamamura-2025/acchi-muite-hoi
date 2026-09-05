import {
  FACE_LABELS,
  POINTER_LABELS,
  type FaceLabel,
  type PointerLabel,
} from '../ml/labels';
import type { ActiveIndex } from '../ml/types';
import type { DatabasePort } from '../data/database';
import { DatasetRepository } from '../data/datasetRepository';
import type { MissingTrainingClasses } from '../data/activeDataset';
import type { ModelServiceStatus } from './modelService';

export interface DatasetClassSummary {
  active: number;
  local: number;
  imported: number;
  ready: boolean;
}

export interface DatasetSummary {
  pointer: Record<PointerLabel, DatasetClassSummary>;
  face: Record<FaceLabel, DatasetClassSummary>;
  totals: {
    active: number;
    local: number;
    imported: number;
  };
}

export interface DatasetModelController {
  getStatus(): ModelServiceStatus;
  getActiveIndex(): ActiveIndex;
  getMissingTrainingClasses(): MissingTrainingClasses;
  refreshFromDatasets(): Promise<void>;
}

/**
 * UI向けのDataset管理境界。
 * UIがDatasetRepository / IndexedDBを直接触らないためのApplication層サービス。
 */
export class DataApplicationService {
  private readonly datasets: DatasetRepository;

  constructor(
    private readonly db: DatabasePort,
    private readonly model: DatasetModelController,
  ) {
    this.datasets = new DatasetRepository(db);
  }

  async getDatasetSummary(): Promise<DatasetSummary> {
    const [localSamples, importedSamples] = await Promise.all([
      this.datasets.getLocalSamples(),
      this.datasets.getImportedSamples(),
    ]);
    const active = this.model.getActiveIndex();
    const missing = this.model.getMissingTrainingClasses();

    const pointer = Object.fromEntries(
      POINTER_LABELS.map((label) => [
        label,
        {
          active: active.pointer[label].length,
          local: localSamples.filter(
            (sample) => sample.domain === 'pointer' && sample.label === label,
          ).length,
          imported: importedSamples.filter(
            (sample) => sample.domain === 'pointer' && sample.label === label,
          ).length,
          ready: !missing.pointer.includes(label),
        },
      ]),
    ) as Record<PointerLabel, DatasetClassSummary>;

    const face = Object.fromEntries(
      FACE_LABELS.map((label) => [
        label,
        {
          active: active.face[label].length,
          local: localSamples.filter((sample) => sample.domain === 'face' && sample.label === label)
            .length,
          imported: importedSamples.filter(
            (sample) => sample.domain === 'face' && sample.label === label,
          ).length,
          ready: !missing.face.includes(label),
        },
      ]),
    ) as Record<FaceLabel, DatasetClassSummary>;

    return {
      pointer,
      face,
      totals: {
        active: totalActive(active),
        local: localSamples.length,
        imported: importedSamples.length,
      },
    };
  }

  async clearLocalDataset(): Promise<void> {
    this.requireReady();
    await this.datasets.clearLocalDataset();
    await this.clearLocalSimilarityCache();
    await this.model.refreshFromDatasets();
  }

  async clearImportedDataset(): Promise<void> {
    this.requireReady();
    await this.datasets.clearImportedDataset();
    await this.model.refreshFromDatasets();
  }

  /**
   * 永続状態を完全初期化する。
   * 呼び出し後は現在のModelServiceを再利用せず、アプリを再起動して新installationIdを発行する。
   */
  async resetApplication(): Promise<void> {
    this.requireReady();
    await this.db.resetAll();
  }

  private requireReady(): void {
    const status = this.model.getStatus();
    if (status.state !== 'ready') {
      throw new Error('データ操作はアプリの準備完了後に実行できます');
    }
  }

  private async clearLocalSimilarityCache(): Promise<void> {
    await Promise.all([
      ...POINTER_LABELS.map((label) => this.db.clearSimilarityCache('pointer', label)),
      ...FACE_LABELS.map((label) => this.db.clearSimilarityCache('face', label)),
    ]);
  }
}

function totalActive(index: ActiveIndex): number {
  return (
    POINTER_LABELS.reduce((total, label) => total + index.pointer[label].length, 0) +
    FACE_LABELS.reduce((total, label) => total + index.face[label].length, 0)
  );
}
