import { MOMENT_CONFIG } from "./config.ts";
import { parseTopic, type MomentTopic } from "./query.ts";

export interface MomentSettings {
  /** ARGUS_MOMENTS=1; off by default, like ARGUS_MEME_IDEAS. */
  enabled: boolean;
  intervalMinutes: number;
  /** The most page loads in any rolling 24 hours. */
  loadsPerDay: number;
  /** The topic; null only while the scanner is off. */
  topic: MomentTopic | null;
}

function wholeNumber(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number, why: string): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  const v = Number(raw);
  if (!/^\d{1,6}$/.test(raw) || v < min || v > max) throw new Error(`${name} must be a whole number from ${min} to ${max} (${why}), got "${env[name]}"`);
  return v;
}

/**
 * The scanner's settings from the environment. Only the exact string "1" turns it on. A number that is out of range is an error and never a
 * fallback, as for the other ARGUS_* caps: the interval cannot go under 15 minutes, and the daily load cap can only be lowered from its
 * default of 100 (the code ceiling of 300 is for the ramp of ticket 08, never for configuration). When the scanner is on, the topic must
 * be set and valid.
 */
export function momentSettingsFromEnv(env: Record<string, string | undefined>): MomentSettings {
  const enabled = env.ARGUS_MOMENTS === "1";
  const intervalMinutes = wholeNumber(env, "ARGUS_MOMENT_INTERVAL_MIN", MOMENT_CONFIG.intervalMinutesDefault, MOMENT_CONFIG.intervalMinutesMin, 24 * 60, "at least 15 minutes");
  const loadsPerDay = wholeNumber(env, "ARGUS_MOMENT_LOADS_PER_DAY", MOMENT_CONFIG.loadsPerDayDefault, 1, MOMENT_CONFIG.loadsPerDayDefault, `it can only lower the cap of ${MOMENT_CONFIG.loadsPerDayDefault}; the code ceiling is ${MOMENT_CONFIG.loadsPerDayCeiling}`);
  if (!enabled) return { enabled, intervalMinutes, loadsPerDay, topic: null };
  const topic = parseTopic(env.ARGUS_MOMENT_TOPIC);
  if (topic === null) throw new Error("ARGUS_MOMENTS=1 needs ARGUS_MOMENT_TOPIC (one JSON object: label, startsAt, spellings)");
  return { enabled, intervalMinutes, loadsPerDay, topic };
}
