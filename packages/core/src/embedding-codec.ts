/** A set of equal-length unit vectors packed for a committed fixture: each number as a signed 16-bit integer, base64. */
export interface EncodedVectors {
  dimension: number;
  count: number;
  data: string;
}

/** Unit vectors have components in [-1, 1], so 16 bits give an error near 1.5e-5 per number, far below any threshold gap. */
const SCALE = 32767;

export function encodeVectors(vectors: readonly (readonly number[])[]): EncodedVectors {
  const dimension = vectors[0]?.length ?? 0;
  const buf = Buffer.alloc(vectors.length * dimension * 2);
  vectors.forEach((v, i) => {
    if (v.length !== dimension) throw new Error(`vector ${i} has dimension ${v.length}, expected ${dimension}`);
    v.forEach((x, j) => buf.writeInt16LE(Math.max(-SCALE, Math.min(SCALE, Math.round(x * SCALE))), (i * dimension + j) * 2));
  });
  return { dimension, count: vectors.length, data: buf.toString("base64") };
}

export function decodeVectors({ dimension, count, data }: EncodedVectors): number[][] {
  const buf = Buffer.from(data, "base64");
  if (buf.length !== count * dimension * 2) throw new Error(`encoded vectors have length ${buf.length}, expected ${count * dimension * 2}`);
  return Array.from({ length: count }, (_, i) => Array.from({ length: dimension }, (_, j) => buf.readInt16LE((i * dimension + j) * 2) / SCALE));
}
