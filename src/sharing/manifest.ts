import type { Domain, FaceLabel, PointerLabel } from '../ml/labels';

export const DATASET_ARCHIVE_FORMAT = 'acchi-muite-hoi-dataset';
export const DATASET_ARCHIVE_FORMAT_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const POINTER_BINARY_FILE = 'pointer.bin';
export const FACE_BINARY_FILE = 'face.bin';

export type DatasetBinaryFileName = typeof POINTER_BINARY_FILE | typeof FACE_BINARY_FILE;

export interface DatasetManifestSample {
  id: string;
  domain: Domain;
  label: PointerLabel | FaceLabel;
  capturedAt: number;
  captureSessionId: string;
  sourceInstallationId: string;
  binaryFile: DatasetBinaryFileName;
  byteOffset: number;
  byteLength: number;
}

export interface DatasetManifestBinary {
  fileName: DatasetBinaryFileName;
  byteLength: number;
  sha256: string;
}

export interface DatasetManifest {
  format: typeof DATASET_ARCHIVE_FORMAT;
  formatVersion: typeof DATASET_ARCHIVE_FORMAT_VERSION;
  datasetVersion: number;
  extractorName: string;
  featureDim: number;
  installationId: string;
  exportedAt: string;
  encoding: {
    feature: 'float32';
    endianness: 'little';
  };
  binaries: {
    pointer: DatasetManifestBinary;
    face: DatasetManifestBinary;
  };
  samples: DatasetManifestSample[];
}

export interface DatasetCompatibilityDescriptor {
  datasetVersion: number;
  extractorName: string;
  featureDim: number;
}

export function expectedBinaryFile(domain: Domain): DatasetBinaryFileName {
  return domain === 'pointer' ? POINTER_BINARY_FILE : FACE_BINARY_FILE;
}
