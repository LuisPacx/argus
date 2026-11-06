import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Embedder } from "@argus/core";
import { tempDir } from "../../../packages/core/src/testing/temp.ts";
import { ModelUnavailableError, SEMANTIC_MODEL, backgroundEmbedder, embedderIdOf, fetchModel,missingFiles, modelCacheDir, type ModelSpec } from "./semantic-embedder.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CONTENT: Record<string, string> = { "config.json": "{}", "onnx/model.onnx": "weights" };
const spec: ModelSpec = {
  ...SEMANTIC_MODEL,
  repo: "acme/tiny",
  revision: "abc1234def",
  files: Object.fromEntries(Object.entries(CONTENT).map(([f, c]) => [f, { sha256: sha(c), bytes: c.length }])),
};
/** A fake huggingface.co: serves CONTENT (or `served`) and records what was asked. */
function fakeHost(served: Record<string, string> = CONTENT) {
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    const file = url.split("/resolve/abc1234def/")[1]!;
    return file in served ? new Response(served[file]) : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { asked, fetchFn };
}

describe("the pinned semantic model", () => {
  it("names a revision (a commit), never a branch, and a sha-256 for every file", () => {
    expect(SEMANTIC_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const f of Object.values(SEMANTIC_MODEL.files)) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps its cache on the home disk by default and under ARGUS_MODEL_DIR when set", () => {
    expect(modelCacheDir({ HOME: "/home/x" }, "/home/x")).toBe("/home/x/.cache/argus/models");
    expect(modelCacheDir({ ARGUS_MODEL_DIR: "/data/models" }, "/home/x")).toBe("/data/models");
  });

  it("names the embedder by model, revision and quantization, so a vector says what built it", () => {
    expect(embedderIdOf(SEMANTIC_MODEL)).toBe(`${SEMANTIC_MODEL.repo}@${SEMANTIC_MODEL.revision.slice(0, 7)}:${SEMANTIC_MODEL.dtype}`);
  });
});

describe("fetching and checking the model", () => {
  it("downloads every file from the pinned revision, verifies it, and leaves no partial file", async () => {
    const dir = tempDir("argus-model-");
    const { asked, fetchFn } = fakeHost();
    expect(missingFiles(dir, spec)).toEqual(["config.json", "onnx/model.onnx"]);
    await fetchModel({ dir, spec, fetchFn, log: () => {} });
    expect(asked).toEqual(["https://huggingface.co/acme/tiny/resolve/abc1234def/config.json", "https://huggingface.co/acme/tiny/resolve/abc1234def/onnx/model.onnx"]);
    expect(readFileSync(join(dir, "acme/tiny/onnx/model.onnx"), "utf8")).toBe("weights");
    expect(missingFiles(dir, spec)).toEqual([]);
    expect(existsSync(join(dir, "acme/tiny/config.json.part"))).toBe(false);
  });

  it("does not download what is already there and intact", async () => {
    const dir = tempDir("argus-model-");
    await fetchModel({ dir, spec, fetchFn: fakeHost().fetchFn, log: () => {} });
    const again = fakeHost();
    await fetchModel({ dir, spec, fetchFn: again.fetchFn, log: () => {} });
    expect(again.asked).toEqual([]);
  });

  it("rejects a file whose checksum is wrong and keeps nothing of it", async () => {
    const dir = tempDir("argus-model-");
    const { fetchFn } = fakeHost({ ...CONTENT, "onnx/model.onnx": "tampered" });
    await expect(fetchModel({ dir, spec, fetchFn, log: () => {} })).rejects.toThrow(ModelUnavailableError);
    expect(existsSync(join(dir, "acme/tiny/onnx/model.onnx"))).toBe(false);
    expect(existsSync(join(dir, "acme/tiny/onnx/model.onnx.part"))).toBe(false);
  });

  it("replaces a corrupted cached file", async () => {
    const dir = tempDir("argus-model-");
    await fetchModel({ dir, spec, fetchFn: fakeHost().fetchFn, log: () => {} });
    writeFileSync(join(dir, "acme/tiny/config.json"), "corrupt");
    expect(missingFiles(dir, spec)).toEqual(["config.json"]);
    await fetchModel({ dir, spec, fetchFn: fakeHost().fetchFn, log: () => {} });
    expect(missingFiles(dir, spec)).toEqual([]);
  });

  it("stops downloading when asked to (the worker is shutting down)", async () => {
    const aborting = (async (_url: string, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const stop = new AbortController();
    const pending = fetchModel({ dir: tempDir("argus-model-"), spec, fetchFn: aborting, log: () => {}, signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toThrow(ModelUnavailableError);
  });

  it("reports an unreachable host or a missing file as ModelUnavailableError", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchModel({ dir: tempDir("argus-model-"), spec, fetchFn: offline, log: () => {} })).rejects.toThrow(/fetch failed/);
    await expect(fetchModel({ dir: tempDir("argus-model-"), spec, fetchFn: fakeHost({}).fetchFn, log: () => {} })).rejects.toThrow(/404/);
  });
});

describe("loading the embedder in the background (a cold start must not hold ingest)", () => {
  const fake = (id: string): Embedder => ({ id, dimension: 2, embed: async () => [1, 0] });
  /** A load that stays pending (a slow download) until released. */
  const slowLoad = () => {
    let release!: (e: Embedder) => void;
    let fail!: (e: Error) => void;
    let loads = 0;
    const load = () => (loads++, new Promise<Embedder>((res, rej) => ((release = res), (fail = rej))));
    return { load, release: (e: Embedder) => release(e), fail: (e: Error) => fail(e), loads: () => loads };
  };

  it("returns at once while a slow download runs, starts it only once, and logs the skip once", () => {
    const d = slowLoad();
    const lines: string[] = [];
    const bg = backgroundEmbedder(d.load, (l) => lines.push(l));
    expect(bg.current()).toBeUndefined(); // does not wait for the download
    expect(bg.current()).toBeUndefined();
    expect(bg.current()).toBeUndefined();
    expect(d.loads()).toBe(1);
    expect(lines.filter((l) => l.includes("skipped"))).toHaveLength(1);
  });

  it("hands the embedder over once the download has finished", async () => {
    const d = slowLoad();
    const bg = backgroundEmbedder(d.load, () => {});
    bg.current();
    d.release(fake("m"));
    await bg.settled();
    expect(bg.current()?.id).toBe("m");
    expect(d.loads()).toBe(1);
  });

  it("an unavailable model is logged, and the next call starts a fresh attempt", async () => {
    const d = slowLoad();
    const lines: string[] = [];
    const bg = backgroundEmbedder(d.load, (l) => lines.push(l));
    bg.current();
    d.fail(new ModelUnavailableError("cannot reach huggingface.co"));
    await bg.settled();
    expect(lines.join("\n")).toContain("cannot reach huggingface.co");
    expect(bg.current()).toBeUndefined();
    expect(d.loads()).toBe(2);
  });

  it("does not hide a bug: any other error is thrown by the next call", async () => {
    const d = slowLoad();
    const bg = backgroundEmbedder(d.load, () => {});
    bg.current();
    d.fail(new Error("onnx runtime exploded"));
    await bg.settled();
    expect(() => bg.current()).toThrow("onnx runtime exploded");
  });
});
