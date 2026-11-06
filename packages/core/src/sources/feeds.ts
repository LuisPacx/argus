import { readFileSync } from "node:fs";
import { RssSource } from "./rss.ts";

/** Reads the RSS catalog (a JSON array of `{ id, label, url }`) and builds a Source per entry. Throws on a malformed catalog. */
export function loadRssSources(path: string): RssSource[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of feeds`);
  const seen = new Set<string>();
  return data.map((entry: unknown, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const { id, label, url } = e;
    if (typeof id !== "string" || !id || typeof label !== "string" || !label || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`${path}: feed #${i + 1} needs a string id, a string label and an http(s) url`);
    }
    if (seen.has(id)) throw new Error(`${path}: duplicate feed id ${id}`);
    seen.add(id);
    return new RssSource({ id, label, url });
  });
}
