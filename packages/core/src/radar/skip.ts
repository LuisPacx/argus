import type { MetaCurrent, NewMetaCurrent } from "../meta/store.ts";
import { radarKey } from "./key.ts";

/**
 * The skip rule (spec section 5.4): a term whose key is the key of the label, or of a merged theme label, of a current Meta or Watching subject
 * is already tokenized and the Meta page owns it, so it is not stored as a Trend (it stays in the readings). Both sides are folded by `radarKey`,
 * so a Meta labelled "GTA 6" skips the Google term "gta vi", and a Meta labelled "GTA VI" skips "gta 6" and "GTA6".
 */
export function skipKeys(current: Pick<MetaCurrent, "metas" | "watching"> | NewMetaCurrent | undefined): Set<string> {
  const keys = new Set<string>();
  if (!current) return keys;
  for (const subject of [...current.metas, ...current.watching]) {
    for (const label of [subject.label, ...(subject.themes ?? []).map((t) => t.label)]) {
      const key = radarKey(label);
      if (key !== "") keys.add(key);
    }
  }
  return keys;
}

/** Whether a term is a current Meta or Watching subject. */
export function isSkipped(term: string, keys: ReadonlySet<string>): boolean {
  const key = radarKey(term);
  return key !== "" && keys.has(key);
}
