import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Embedder, Embedding } from "@argus/core";

/**
 * The in-process sentence embedder for Narratives (docs/adr/0007). A small quantized ONNX model run by transformers.js
 * (onnxruntime-node) inside the worker: no server, no API key. The weights come from huggingface.co once, pinned to a
 * commit and checked against a sha-256 per file; after that nothing touches the network.
 */
export interface ModelSpec {
  /** Hugging Face repo; also the directory name under the cache. */
  repo: string;
  /** A commit sha of that repo, never a branch. */
  revision: string;
  /** The quantization transformers.js loads (onnx/model_quantized.onnx). */
  dtype: "q8";
  pooling: "mean" | "cls";
  dimension: number;
  /** Every file the model needs, by repo path, with the sha-256 and size of the pinned revision. */
  files: Record<string, { sha256: string; bytes: number }>;
}

/** Xenova/gte-small (the ONNX export of thenlper/gte-small, MIT), 8-bit quantized. Chosen by measurement: docs/adr/0007. */
export const SEMANTIC_MODEL: ModelSpec = {
  repo: "Xenova/gte-small",
  revision: "5927d1727bb12db490052a1b33265ad78058de08",
  dtype: "q8",
  pooling: "mean",
  dimension: 384,
  files: {
    "config.json": { sha256: "73f82cfb2bab7b9b7da090b2a71dac32f7ca79b12b2824d4caf9ecf0769b44ae", bytes: 601 },
    "tokenizer.json": { sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0", bytes: 711661 },
    "tokenizer_config.json": { sha256: "73687f47b47aedc8bfa8712f7e6616450058f1f1bb3d5e5861f8a92964d6467a", bytes: 557 },
    "onnx/model_quantized.onnx": { sha256: "18dec105109b6004369799ca4761fb8fb413c64172c02147bcfac186b5c5f6cb", bytes: 34014426 },
  },
};

/** The model is missing, unreachable or failed its checksum. Expected, recoverable; anything else is a bug and propagates. */
export class ModelUnavailableError extends Error {}

/** On the home disk (never /tmp, the repo or a scratchpad); ARGUS_MODEL_DIR moves it. */
export function modelCacheDir(env: Record<string, string | undefined>, home = homedir()): string {
  return env.ARGUS_MODEL_DIR || join(env.HOME || home, ".cache", "argus", "models");
}

export const embedderIdOf = (spec: ModelSpec): string => `${spec.repo}@${spec.revision.slice(0, 7)}:${spec.dtype}`;

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
const fileAt = (dir: string, spec: ModelSpec, file: string): string => join(dir, spec.repo, file);

/** The files that are absent or whose checksum is wrong. Empty means the model is ready. */
export function missingFiles(dir: string, spec: ModelSpec): string[] {
  return Object.entries(spec.files)
    .filter(([file, { sha256: want, bytes }]) => {
      const path = fileAt(dir, spec, file);
      if (!existsSync(path)) return true;
      const buf = readFileSync(path);
      return buf.length !== bytes || sha256(buf) !== want;
    })
    .map(([file]) => file);
}

export interface FetchModelOptions {
  dir: string;
  spec: ModelSpec;
  /** Defaults to https://huggingface.co; tests and mirrors point it elsewhere (ARGUS_MODEL_HOST). */
  host?: string;
  fetchFn?: typeof fetch;
  /** Aborts the download (the worker is stopping). */
  signal?: AbortSignal;
  log: (line: string) => void;
}

/** Downloads what `missingFiles` reports, verifying each file before it is moved into place. Throws ModelUnavailableError. */
export async function fetchModel({ dir, spec, host = "https://huggingface.co", fetchFn = fetch, signal, log }: FetchModelOptions): Promise<void> {
  for (const file of missingFiles(dir, spec)) {
    const url = `${host}/${spec.repo}/resolve/${spec.revision}/${file}`;
    const want = spec.files[file]!;
    log(`[models] downloading ${spec.repo}/${file} (${(want.bytes / 1e6).toFixed(1)} MB) from ${host}`);
    let buf: Buffer;
    try {
      const timeout = AbortSignal.timeout(15 * 60_000);
      const res = await fetchFn(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (!res.ok) throw new ModelUnavailableError(`${url} answered ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof ModelUnavailableError) throw err;
      throw new ModelUnavailableError(`cannot download ${url}: ${err instanceof Error ? err.message : err}`);
    }
    if (buf.length !== want.bytes || sha256(buf) !== want.sha256) throw new ModelUnavailableError(`${file} from ${url} failed its checksum (got ${buf.length} bytes, sha-256 ${sha256(buf)})`);
    const path = fileAt(dir, spec, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.part`, buf);
    try {
      renameSync(`${path}.part`, path);
    } catch (err) {
      rmSync(`${path}.part`, { force: true });
      throw err;
    }
  }
}

export interface LoadOptions {
  dir: string;
  spec?: ModelSpec;
  /** False (the dry run, tests) means a missing model is an error, never a download. */
  allowFetch?: boolean;
  host?: string;
  signal?: AbortSignal;
  log: (line: string) => void;
}

/** Makes the model ready (fetching it if allowed) and returns an Embedder over it. Throws ModelUnavailableError. */
export async function loadSemanticEmbedder({ dir, spec = SEMANTIC_MODEL, allowFetch = true, host, signal, log }: LoadOptions): Promise<Embedder> {
  if (missingFiles(dir, spec).length > 0) {
    if (!allowFetch) throw new ModelUnavailableError(`model ${spec.repo} is not in ${dir} (run \`pnpm models:fetch\`)`);
    await fetchModel({ dir, spec, host, signal, log });
  }
  // Imported here so a worker that never clusters (a dry run) never loads onnxruntime.
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false; // fetchModel is the only thing that talks to the network
  env.allowLocalModels = true;
  env.localModelPath = dir.endsWith("/") ? dir : `${dir}/`;
  const extractor = await pipeline("feature-extraction", spec.repo, { dtype: spec.dtype, session_options: { intraOpNumThreads: 2 } });
  log(`[models] loaded ${embedderIdOf(spec)} (${spec.dimension} dims)`);
  return {
    id: embedderIdOf(spec),
    dimension: spec.dimension,
    // Headlines only: the model was measured on titles (docs/adr/0007), and RSS summaries are mostly markup and boilerplate.
    async embed(signal): Promise<Embedding> {
      const out = await extractor(signal.title, { pooling: spec.pooling, normalize: true });
      return Array.from(out.data as Float32Array);
    },
  };
}

/**
 * Loads the embedder in the background so a cold start (up to four downloads of 15 minutes) never holds the ingest tick.
 * `current()` never waits: it returns the embedder once it is ready, and otherwise undefined (the caller skips clustering that tick),
 * starting a load if none is running (so the download begins after the first ingest and a failed one is retried on the next call).
 * The skip is logged once. A missing or unreachable model is logged; any other error is a bug and is thrown by the next `current()`.
 * `settled()` resolves when the load in progress, if any, has ended (the one-shot `--once` run waits on it).
 */
export function backgroundEmbedder(load: () => Promise<Embedder>, log: (line: string) => void): { current(): Embedder | undefined; settled(): Promise<void> } {
  let ready: Embedder | undefined;
  let loading: Promise<void> | undefined;
  let bug: unknown;
  let noted = false;
  const start = () => {
    loading = load().then(
      (e) => {
        ready = e;
      },
      (err) => {
        if (err instanceof ModelUnavailableError) log(`[worker] cluster: skipped, semantic model unavailable: ${err.message}`);
        else bug = err;
      },
    ).finally(() => {
      loading = undefined;
    });
  };
  return {
    current() {
      if (ready) return ready;
      if (bug !== undefined) {
        const err = bug;
        bug = undefined;
        throw err;
      }
      if (!loading) start();
      if (!noted) {
        noted = true;
        log("[worker] cluster: skipped until the semantic model is ready (loading in the background; ingest is not held)");
      }
      return undefined;
    },
    settled: async () => {
      await loading;
    },
  };
}
