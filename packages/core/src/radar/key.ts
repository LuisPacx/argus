import { aliasKey, normaliseKey } from "../meta/key.ts";

/**
 * What "the same name" means for a Trend: exactly what it means for a Meta (`meta/key.ts`), so a Meta "GTA 6" and the Google term "gta vi" are
 * one key. "GTA VI", "GTA 6", "GTA6" and "#GTA6" give `gta6`. Empty when nothing is left (punctuation, emoji). The radar has no normaliser of its
 * own and builds no RegExp from the text (a test reads this directory to check both).
 */
export function radarKey(term: string): string {
  return aliasKey(normaliseKey(term));
}
