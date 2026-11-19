import { RADAR_CONFIG } from "./config.ts";

export interface RadarSettings {
  /** ARGUS_RADAR=1; off by default, like ARGUS_MOMENTS. */
  enabled: boolean;
  /** DexScreener searches in one tick, at most. */
  searchesPerTick: number;
}

/**
 * The radar's settings from the environment. Unset, empty and "0" are off and "1" is on; any other value is an error and never a guess (as for
 * the other ARGUS_* settings). `ARGUS_RADAR_SEARCHES_PER_TICK` can only lower the cap of 30 in code, never raise it.
 */
export function radarSettingsFromEnv(env: Record<string, string | undefined>): RadarSettings {
  const raw = (env.ARGUS_RADAR ?? "").trim();
  if (raw !== "" && raw !== "0" && raw !== "1") throw new Error(`ARGUS_RADAR must be 1 (on), 0 or unset (off), got "${env.ARGUS_RADAR}"`);
  const cap = RADAR_CONFIG.searchesPerTick;
  const searchRaw = (env.ARGUS_RADAR_SEARCHES_PER_TICK ?? "").trim();
  let searchesPerTick: number = cap;
  if (searchRaw !== "") {
    const v = Number(searchRaw);
    if (!/^\d{1,4}$/.test(searchRaw) || v < 1 || v > cap) throw new Error(`ARGUS_RADAR_SEARCHES_PER_TICK must be a whole number from 1 to ${cap} (it can only lower the cap of ${cap}), got "${env.ARGUS_RADAR_SEARCHES_PER_TICK}"`);
    searchesPerTick = v;
  }
  return { enabled: raw === "1", searchesPerTick };
}
