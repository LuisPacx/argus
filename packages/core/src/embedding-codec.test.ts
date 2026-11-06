import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "./narratives.ts";
import { decodeVectors, encodeVectors } from "./embedding-codec.ts";

describe("the compact embedding fixture format", () => {
  const unit = (v: number[]) => {
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / m);
  };
  const vectors = [unit([0.3, -0.5, 0.1, 0.8]), unit([-0.2, 0.4, 0.9, -0.1]), unit([1, 1, 1, 1])];

  it("round-trips unit vectors to well within a cosine of 0.001", () => {
    const back = decodeVectors(encodeVectors(vectors));
    expect(back).toHaveLength(3);
    for (let i = 0; i < vectors.length; i++) {
      expect(back[i]).toHaveLength(4);
      expect(cosineSimilarity(vectors[i]!, back[i]!)).toBeGreaterThan(0.999999);
    }
  });

  it("is a short base64 string, two bytes per number", () => {
    const { dimension, count, data } = encodeVectors(vectors);
    expect([dimension, count]).toEqual([4, 3]);
    expect(Buffer.from(data, "base64")).toHaveLength(4 * 3 * 2);
  });

  it("rejects data whose length does not match its count and dimension", () => {
    const enc = encodeVectors(vectors);
    expect(() => decodeVectors({ ...enc, count: 4 })).toThrow(/length/);
  });

  it("rejects vectors of different lengths", () => {
    expect(() => encodeVectors([[1, 0], [1]])).toThrow(/dimension/);
  });
});
