const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED_METHOD = 0;

export class ZipFormatError extends Error {}
export class ZipIntegrityError extends Error {}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

interface EncodedEntry extends ZipEntry {
  nameBytes: Uint8Array;
  crc: number;
  localOffset: number;
}

export function writeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length === 0) throw new ZipFormatError('ZIP must contain at least one entry');
  assertUniqueNames(entries.map((entry) => entry.name));

  const encoded: EncodedEntry[] = [];
  const localChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    validateName(entry.name);
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_FILE_HEADER, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, STORED_METHOD, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.byteLength, true);
    view.setUint32(22, entry.data.byteLength, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    encoded.push({ ...entry, nameBytes, crc, localOffset });
    localChunks.push(header, entry.data);
    localOffset += header.byteLength + entry.data.byteLength;
  }

  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of encoded) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, CENTRAL_DIRECTORY_HEADER, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, STORED_METHOD, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.byteLength, true);
    view.setUint32(24, entry.data.byteLength, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, entry.localOffset, true);
    header.set(entry.nameBytes, 46);
    centralChunks.push(header);
    centralSize += header.byteLength;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, encoded.length, true);
  endView.setUint16(10, encoded.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localChunks, ...centralChunks, end]);
}

export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  const decoder = new TextDecoder();

  while (offset + 4 <= bytes.byteLength) {
    const signature = readUint32(bytes, offset);
    if (signature === CENTRAL_DIRECTORY_HEADER) break;
    if (signature !== LOCAL_FILE_HEADER) throw new ZipFormatError('invalid ZIP local header');
    if (offset + 30 > bytes.byteLength) throw new ZipFormatError('truncated ZIP local header');

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    const expectedCrc = view.getUint32(14, true);
    const compressedSize = view.getUint32(18, true);
    const uncompressedSize = view.getUint32(22, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);

    if (flags !== 0) throw new ZipFormatError('unsupported ZIP flags');
    if (method !== STORED_METHOD) throw new ZipFormatError('compressed ZIP entries are not supported');
    if (compressedSize !== uncompressedSize) throw new ZipFormatError('invalid stored ZIP sizes');

    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > bytes.byteLength || dataEnd > bytes.byteLength) {
      throw new ZipFormatError('truncated ZIP entry');
    }

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    validateName(name);
    if (files.has(name)) throw new ZipFormatError(`duplicate ZIP entry: ${name}`);

    const data = new Uint8Array(bytes.subarray(dataStart, dataEnd));
    if (crc32(data) !== expectedCrc) throw new ZipIntegrityError(`ZIP CRC mismatch: ${name}`);
    files.set(name, data);
    offset = dataEnd;
  }

  if (files.size === 0) throw new ZipFormatError('ZIP contains no readable files');
  validateCentralDirectory(bytes, offset, files, decoder);
  return files;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ value) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function validateCentralDirectory(
  bytes: Uint8Array,
  centralOffset: number,
  files: ReadonlyMap<string, Uint8Array>,
  decoder: TextDecoder,
): void {
  let offset = centralOffset;
  const centralNames: string[] = [];

  for (let i = 0; i < files.size; i += 1) {
    if (offset + 46 > bytes.byteLength || readUint32(bytes, offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new ZipFormatError('invalid ZIP central directory');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 46);
    const flags = view.getUint16(8, true);
    const method = view.getUint16(10, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) throw new ZipFormatError('truncated ZIP central directory');
    if (flags !== 0 || method !== STORED_METHOD || compressedSize !== uncompressedSize) {
      throw new ZipFormatError('unsupported ZIP central directory entry');
    }

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    validateName(name);
    const localData = files.get(name);
    if (!localData || localData.byteLength !== uncompressedSize) {
      throw new ZipFormatError(`ZIP central directory mismatch: ${name}`);
    }
    centralNames.push(name);
    offset = next;
  }

  assertUniqueNames(centralNames);
  if (offset + 22 !== bytes.byteLength || readUint32(bytes, offset) !== END_OF_CENTRAL_DIRECTORY) {
    throw new ZipFormatError('invalid ZIP end record');
  }
  const end = new DataView(bytes.buffer, bytes.byteOffset + offset, 22);
  const disk = end.getUint16(4, true);
  const startDisk = end.getUint16(6, true);
  const entriesOnDisk = end.getUint16(8, true);
  const totalEntries = end.getUint16(10, true);
  const centralSize = end.getUint32(12, true);
  const declaredCentralOffset = end.getUint32(16, true);
  const commentLength = end.getUint16(20, true);
  if (
    disk !== 0 ||
    startDisk !== 0 ||
    entriesOnDisk !== files.size ||
    totalEntries !== files.size ||
    centralSize !== offset - centralOffset ||
    declaredCentralOffset !== centralOffset ||
    commentLength !== 0
  ) {
    throw new ZipFormatError('ZIP end record mismatch');
  }
}

function validateName(name: string): void {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\u0000')) {
    throw new ZipFormatError(`invalid ZIP entry name: ${name}`);
  }
}

function assertUniqueNames(names: readonly string[]): void {
  if (new Set(names).size !== names.length) throw new ZipFormatError('duplicate ZIP entry name');
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) throw new ZipFormatError('truncated ZIP signature');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();
