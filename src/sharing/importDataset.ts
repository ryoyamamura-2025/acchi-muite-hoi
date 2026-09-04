import type { DatasetRepository } from '../data/datasetRepository';
import { FACE_LABELS, POINTER_LABELS, isDomainLabel } from '../ml/labels';
import type { AnyLabel, Domain } from '../ml/labels';
import type { Sample } from '../ml/types';
import { decodeFloat32LittleEndian, sha256Hex } from './binary';
import {
  DATASET_ARCHIVE_FORMAT,
  DATASET_ARCHIVE_FORMAT_VERSION,
  FACE_BINARY_FILE,
  MANIFEST_FILE,
  POINTER_BINARY_FILE,
  expectedBinaryFile,
  type DatasetCompatibilityDescriptor,
  type DatasetManifest,
  type DatasetManifestBinary,
  type DatasetManifestSample,
} from './manifest';
import { readStoredZip, ZipFormatError, ZipIntegrityError } from './zip';

export type ImportDatasetErrorCode =
  | 'invalid-format'
  | 'checksum-mismatch'
  | 'dataset-version-mismatch'
  | 'extractor-incompatible'
  | 'limit-exceeded'
  | 'import-error';

export type ImportDatasetResult =
  | {
      kind: 'success';
      sourceInstallationId: string;
      importedSampleCount: number;
      replacedSampleCount: number;
      dataRevision: number;
    }
  | {
      kind: 'error';
      code: ImportDatasetErrorCode;
      message: string;
    };

export interface ImportDatasetOptions {
  bytes: Uint8Array;
  datasetRepository: DatasetRepository;
  compatibility: DatasetCompatibilityDescriptor;
  currentDataRevision: number;
}

const MAX_PER_SOURCE_CLASS = 100;
const MAX_IMPORTED_PER_CLASS = 500;

export async function importDatasetArchive(
  options: ImportDatasetOptions,
): Promise<ImportDatasetResult> {
  try {
    const files = readStoredZip(options.bytes);
    assertArchiveFiles(files);

    const manifest = parseManifest(requireFile(files, MANIFEST_FILE));
    validateCompatibility(manifest, options.compatibility);

    const pointerBin = requireFile(files, POINTER_BINARY_FILE);
    const faceBin = requireFile(files, FACE_BINARY_FILE);
    validateBinaryDescriptor(manifest.binaries.pointer, POINTER_BINARY_FILE, pointerBin);
    validateBinaryDescriptor(manifest.binaries.face, FACE_BINARY_FILE, faceBin);

    const [pointerHash, faceHash] = await Promise.all([
      sha256Hex(pointerBin),
      sha256Hex(faceBin),
    ]);
    if (pointerHash !== manifest.binaries.pointer.sha256.toLowerCase()) {
      throw new ImportValidationError('checksum-mismatch', 'pointer.bin checksum mismatch');
    }
    if (faceHash !== manifest.binaries.face.sha256.toLowerCase()) {
      throw new ImportValidationError('checksum-mismatch', 'face.bin checksum mismatch');
    }

    validateManifestSamples(manifest, pointerBin.byteLength, faceBin.byteLength);
    const samples = decodeSamples(manifest, pointerBin, faceBin);
    validatePerSourceLimits(samples);

    const existingImported = await options.datasetRepository.getImportedSamples();
    validateFinalImportedLimits(existingImported, samples, manifest.installationId);
    const replacedSampleCount = existingImported.filter(
      (sample) => sample.sourceInstallationId === manifest.installationId,
    ).length;

    const dataRevision = options.currentDataRevision + 1;
    await options.datasetRepository.replaceImportedSource(
      manifest.installationId,
      samples,
      dataRevision,
    );

    return {
      kind: 'success',
      sourceInstallationId: manifest.installationId,
      importedSampleCount: samples.length,
      replacedSampleCount,
      dataRevision,
    };
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return { kind: 'error', code: error.code, message: error.message };
    }
    if (error instanceof ZipIntegrityError) {
      return { kind: 'error', code: 'checksum-mismatch', message: error.message };
    }
    if (error instanceof ZipFormatError || error instanceof SyntaxError) {
      return { kind: 'error', code: 'invalid-format', message: error.message };
    }
    return {
      kind: 'error',
      code: 'import-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

class ImportValidationError extends Error {
  constructor(
    readonly code: ImportDatasetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertArchiveFiles(files: ReadonlyMap<string, Uint8Array>): void {
  const expected = new Set([MANIFEST_FILE, POINTER_BINARY_FILE, FACE_BINARY_FILE]);
  if (files.size !== expected.size || [...files.keys()].some((name) => !expected.has(name))) {
    throw new ImportValidationError(
      'invalid-format',
      'Dataset ZIP must contain only manifest.json, pointer.bin, and face.bin',
    );
  }
}

function requireFile(files: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const file = files.get(name);
  if (!file) throw new ImportValidationError('invalid-format', `missing archive file: ${name}`);
  return file;
}

function parseManifest(bytes: Uint8Array): DatasetManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw error instanceof SyntaxError ? error : new SyntaxError('invalid manifest JSON');
  }
  if (!isRecord(value)) throwInvalid('manifest must be an object');

  if (value.format !== DATASET_ARCHIVE_FORMAT) throwInvalid('unsupported Dataset archive format');
  if (value.formatVersion !== DATASET_ARCHIVE_FORMAT_VERSION) {
    throwInvalid('unsupported Dataset archive format version');
  }
  if (!isNonNegativeInteger(value.datasetVersion)) throwInvalid('invalid datasetVersion');
  if (!isNonEmptyString(value.extractorName)) throwInvalid('invalid extractorName');
  if (!isPositiveInteger(value.featureDim)) throwInvalid('invalid featureDim');
  if (!isNonEmptyString(value.installationId)) throwInvalid('invalid installationId');
  if (!isNonEmptyString(value.exportedAt) || Number.isNaN(Date.parse(value.exportedAt))) {
    throwInvalid('invalid exportedAt');
  }

  const encoding = value.encoding;
  if (!isRecord(encoding) || encoding.feature !== 'float32' || encoding.endianness !== 'little') {
    throwInvalid('unsupported feature encoding');
  }

  const binaries = value.binaries;
  if (!isRecord(binaries)) throwInvalid('invalid binaries descriptor');
  const pointer = parseBinaryDescriptor(binaries.pointer, POINTER_BINARY_FILE);
  const face = parseBinaryDescriptor(binaries.face, FACE_BINARY_FILE);
  if (!Array.isArray(value.samples)) throwInvalid('manifest samples must be an array');

  return {
    format: DATASET_ARCHIVE_FORMAT,
    formatVersion: DATASET_ARCHIVE_FORMAT_VERSION,
    datasetVersion: value.datasetVersion as number,
    extractorName: value.extractorName as string,
    featureDim: value.featureDim as number,
    installationId: value.installationId as string,
    exportedAt: value.exportedAt as string,
    encoding: { feature: 'float32', endianness: 'little' },
    binaries: { pointer, face },
    samples: value.samples as DatasetManifestSample[],
  };
}

function parseBinaryDescriptor(value: unknown, fileName: string): DatasetManifestBinary {
  if (!isRecord(value)) throwInvalid(`invalid ${fileName} descriptor`);
  if (value.fileName !== fileName) throwInvalid(`invalid ${fileName} name`);
  if (!isNonNegativeInteger(value.byteLength)) throwInvalid(`invalid ${fileName} byteLength`);
  if (!isSha256(value.sha256)) throwInvalid(`invalid ${fileName} SHA-256`);
  return {
    fileName: fileName as DatasetManifestBinary['fileName'],
    byteLength: value.byteLength as number,
    sha256: (value.sha256 as string).toLowerCase(),
  };
}

function validateCompatibility(
  manifest: DatasetManifest,
  expected: DatasetCompatibilityDescriptor,
): void {
  if (manifest.datasetVersion !== expected.datasetVersion) {
    throw new ImportValidationError(
      'dataset-version-mismatch',
      `Dataset version mismatch: ${manifest.datasetVersion} !== ${expected.datasetVersion}`,
    );
  }
  if (manifest.extractorName !== expected.extractorName || manifest.featureDim !== expected.featureDim) {
    throw new ImportValidationError('extractor-incompatible', 'Dataset extractor is incompatible');
  }
}

function validateBinaryDescriptor(
  descriptor: DatasetManifestBinary,
  expectedName: string,
  bytes: Uint8Array,
): void {
  if (descriptor.fileName !== expectedName || descriptor.byteLength !== bytes.byteLength) {
    throw new ImportValidationError('invalid-format', `${expectedName} size does not match manifest`);
  }
}

function validateManifestSamples(
  manifest: DatasetManifest,
  pointerByteLength: number,
  faceByteLength: number,
): void {
  const ids = new Set<string>();
  const pointerRecords: DatasetManifestSample[] = [];
  const faceRecords: DatasetManifestSample[] = [];
  const expectedByteLength = manifest.featureDim * 4;

  for (const raw of manifest.samples) {
    if (!isRecord(raw)) throwInvalid('invalid sample metadata');
    const sample = raw as unknown as DatasetManifestSample;
    if (!isNonEmptyString(sample.id) || ids.has(sample.id)) throwInvalid('duplicate or invalid sample id');
    ids.add(sample.id);
    if (sample.domain !== 'pointer' && sample.domain !== 'face') throwInvalid('invalid sample domain');
    if (!isNonEmptyString(sample.label) || !isDomainLabel(sample.domain, sample.label)) {
      throwInvalid(`invalid sample label: ${String(sample.label)}`);
    }
    if (!Number.isFinite(sample.capturedAt)) throwInvalid('invalid capturedAt');
    if (!isNonEmptyString(sample.captureSessionId)) throwInvalid('invalid captureSessionId');
    if (sample.sourceInstallationId !== manifest.installationId) {
      throwInvalid('sample sourceInstallationId does not match manifest installationId');
    }
    if (sample.binaryFile !== expectedBinaryFile(sample.domain)) throwInvalid('sample binaryFile mismatch');
    if (!isNonNegativeInteger(sample.byteOffset) || sample.byteOffset % 4 !== 0) {
      throwInvalid('invalid sample byteOffset');
    }
    if (sample.byteLength !== expectedByteLength) throwInvalid('invalid sample byteLength');

    if (sample.domain === 'pointer') pointerRecords.push(sample);
    else faceRecords.push(sample);
  }

  validateContiguousRanges(pointerRecords, pointerByteLength);
  validateContiguousRanges(faceRecords, faceByteLength);
}

function validateContiguousRanges(records: readonly DatasetManifestSample[], binaryLength: number): void {
  const sorted = [...records].sort((a, b) => a.byteOffset - b.byteOffset);
  let expectedOffset = 0;
  for (const record of sorted) {
    if (record.byteOffset !== expectedOffset) throwInvalid('feature binary ranges must be contiguous');
    expectedOffset += record.byteLength;
  }
  if (expectedOffset !== binaryLength) throwInvalid('feature binary length does not match sample ranges');
}

function decodeSamples(
  manifest: DatasetManifest,
  pointerBin: Uint8Array,
  faceBin: Uint8Array,
): Sample[] {
  return manifest.samples.map((record) => {
    const bin = record.domain === 'pointer' ? pointerBin : faceBin;
    const feature = decodeFloat32LittleEndian(bin, record.byteOffset, manifest.featureDim);
    return {
      id: record.id,
      domain: record.domain,
      label: record.label,
      feature,
      capturedAt: record.capturedAt,
      captureSessionId: record.captureSessionId,
      sourceInstallationId: record.sourceInstallationId,
    } as Sample;
  });
}

function validatePerSourceLimits(samples: readonly Sample[]): void {
  forEachDomainLabel((domain, label) => {
    if (countClass(samples, domain, label) > MAX_PER_SOURCE_CLASS) {
      throw new ImportValidationError(
        'limit-exceeded',
        `source limit exceeded: ${domain}/${label} > ${MAX_PER_SOURCE_CLASS}`,
      );
    }
  });
}

function validateFinalImportedLimits(
  existingImported: readonly Sample[],
  incoming: readonly Sample[],
  sourceInstallationId: string,
): void {
  const remaining = existingImported.filter(
    (sample) => sample.sourceInstallationId !== sourceInstallationId,
  );
  forEachDomainLabel((domain, label) => {
    const total = countClass(remaining, domain, label) + countClass(incoming, domain, label);
    if (total > MAX_IMPORTED_PER_CLASS) {
      throw new ImportValidationError(
        'limit-exceeded',
        `Imported total limit exceeded: ${domain}/${label} ${total} > ${MAX_IMPORTED_PER_CLASS}`,
      );
    }
  });
}

function forEachDomainLabel(action: (domain: Domain, label: AnyLabel) => void): void {
  for (const label of POINTER_LABELS) action('pointer', label);
  for (const label of FACE_LABELS) action('face', label);
}

function countClass(samples: readonly Sample[], domain: Domain, label: AnyLabel): number {
  return samples.filter((sample) => sample.domain === domain && sample.label === label).length;
}

function throwInvalid(message: string): never {
  throw new ImportValidationError('invalid-format', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}
