import type { DatasetRepository } from '../data/datasetRepository';
import type { Sample } from '../ml/types';
import { encodeFloat32LittleEndian, sha256Hex } from './binary';
import {
  DATASET_ARCHIVE_FORMAT,
  DATASET_ARCHIVE_FORMAT_VERSION,
  FACE_BINARY_FILE,
  MANIFEST_FILE,
  POINTER_BINARY_FILE,
  type DatasetManifest,
  type DatasetManifestSample,
} from './manifest';
import { writeStoredZip } from './zip';

export interface ExportLocalDatasetOptions {
  datasetRepository: DatasetRepository;
  installationId: string;
  datasetVersion: number;
  extractorName: string;
  featureDim: number;
  exportedAt?: Date;
}

export interface DatasetExport {
  fileName: string;
  mimeType: 'application/zip';
  bytes: Uint8Array;
  sampleCount: number;
}

export async function exportLocalDataset(
  options: ExportLocalDatasetOptions,
): Promise<DatasetExport> {
  const samples = (await options.datasetRepository.getLocalSamples()).sort(compareSamples);
  assertExportableSamples(samples, options.installationId, options.featureDim);

  const pointerSamples = samples.filter((sample) => sample.domain === 'pointer');
  const faceSamples = samples.filter((sample) => sample.domain === 'face');
  const pointerBin = encodeFloat32LittleEndian(pointerSamples.map((sample) => sample.feature));
  const faceBin = encodeFloat32LittleEndian(faceSamples.map((sample) => sample.feature));

  const pointerRecords = createManifestRecords(pointerSamples, POINTER_BINARY_FILE, options.featureDim);
  const faceRecords = createManifestRecords(faceSamples, FACE_BINARY_FILE, options.featureDim);
  const exportedAt = options.exportedAt ?? new Date();

  const manifest: DatasetManifest = {
    format: DATASET_ARCHIVE_FORMAT,
    formatVersion: DATASET_ARCHIVE_FORMAT_VERSION,
    datasetVersion: options.datasetVersion,
    extractorName: options.extractorName,
    featureDim: options.featureDim,
    installationId: options.installationId,
    exportedAt: exportedAt.toISOString(),
    encoding: { feature: 'float32', endianness: 'little' },
    binaries: {
      pointer: {
        fileName: POINTER_BINARY_FILE,
        byteLength: pointerBin.byteLength,
        sha256: await sha256Hex(pointerBin),
      },
      face: {
        fileName: FACE_BINARY_FILE,
        byteLength: faceBin.byteLength,
        sha256: await sha256Hex(faceBin),
      },
    },
    samples: [...pointerRecords, ...faceRecords],
  };

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const bytes = writeStoredZip([
    { name: MANIFEST_FILE, data: manifestBytes },
    { name: POINTER_BINARY_FILE, data: pointerBin },
    { name: FACE_BINARY_FILE, data: faceBin },
  ]);

  return {
    fileName: `acchi-muite-hoi-dataset_${fileTimestamp(exportedAt)}.zip`,
    mimeType: 'application/zip',
    bytes,
    sampleCount: samples.length,
  };
}

function createManifestRecords(
  samples: readonly Sample[],
  binaryFile: typeof POINTER_BINARY_FILE | typeof FACE_BINARY_FILE,
  featureDim: number,
): DatasetManifestSample[] {
  const byteLength = featureDim * 4;
  return samples.map((sample, index) => ({
    id: sample.id,
    domain: sample.domain,
    label: sample.label,
    capturedAt: sample.capturedAt,
    captureSessionId: sample.captureSessionId,
    sourceInstallationId: sample.sourceInstallationId,
    binaryFile,
    byteOffset: index * byteLength,
    byteLength,
  }));
}

function assertExportableSamples(
  samples: readonly Sample[],
  installationId: string,
  featureDim: number,
): void {
  if (!installationId) throw new Error('installationId is required');
  if (!Number.isInteger(featureDim) || featureDim <= 0) throw new Error('featureDim must be positive');

  const ids = new Set<string>();
  for (const sample of samples) {
    if (sample.sourceInstallationId !== installationId) {
      throw new Error('Local Dataset contains a different sourceInstallationId');
    }
    if (sample.feature.length !== featureDim) {
      throw new Error(`featureDim mismatch in Local Dataset: ${sample.id}`);
    }
    if (ids.has(sample.id)) throw new Error(`duplicate Local sample id: ${sample.id}`);
    ids.add(sample.id);
  }
}

function compareSamples(a: Sample, b: Sample): number {
  const domain = a.domain.localeCompare(b.domain);
  if (domain !== 0) return domain;
  const label = a.label.localeCompare(b.label);
  if (label !== 0) return label;
  return a.id.localeCompare(b.id);
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
