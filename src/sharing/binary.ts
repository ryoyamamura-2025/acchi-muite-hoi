export function encodeFloat32LittleEndian(features: readonly Float32Array[]): Uint8Array {
  const floatCount = features.reduce((sum, feature) => sum + feature.length, 0);
  const bytes = new Uint8Array(floatCount * 4);
  const view = new DataView(bytes.buffer);
  let byteOffset = 0;
  for (const feature of features) {
    for (const value of feature) {
      view.setFloat32(byteOffset, value, true);
      byteOffset += 4;
    }
  }
  return bytes;
}

export function decodeFloat32LittleEndian(
  bytes: Uint8Array,
  byteOffset: number,
  featureDim: number,
): Float32Array {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset % 4 !== 0) {
    throw new Error(`invalid feature byteOffset: ${byteOffset}`);
  }
  if (!Number.isInteger(featureDim) || featureDim <= 0) {
    throw new Error(`invalid featureDim: ${featureDim}`);
  }
  const byteLength = featureDim * 4;
  if (byteOffset + byteLength > bytes.byteLength) throw new Error('feature range exceeds binary file');

  const feature = new Float32Array(featureDim);
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, byteLength);
  for (let i = 0; i < featureDim; i += 1) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) throw new Error('feature contains a non-finite value');
    feature[i] = value;
  }
  return feature;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
