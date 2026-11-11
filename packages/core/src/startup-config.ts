import { apiFallbackConfigFromEnv } from "./api-fallback.ts";
import { judgeConfigFromEnv } from "./judge.ts";
import { metaConfigFromEnv, metaIntervalMinutes } from "./meta/config.ts";
import { metaSummaryConfigFromEnv } from "./meta/summary-pass.ts";
import { proposeConfigFromEnv } from "./propose.ts";
import { researchConfigFromEnv } from "./research-budget.ts";
import { captureRunCap, STUDY_CAPTURE_RULE } from "./study/config.ts";

/** What the environment cannot say: whether a secret is present, and whether the Study is running. Booleans only, so no secret can reach the line. */
export interface StartupFacts {
  apiKeySet: boolean;
  telegramOn: boolean;
  studyOn: boolean;
}

/**
 * The worker's effective config as one `[config] key=value ...` line, logged at startup so a reader of worker.log can verify it instead of
 * assuming defaults. It reads only the numeric caps from `env` (through the same parsers the passes use); keys and tokens appear only as
 * set/unset or on/off, never their values.
 */
export function startupConfigLine(env: Record<string, string | undefined>, facts: StartupFacts): string {
  const judge = judgeConfigFromEnv(env);
  const propose = proposeConfigFromEnv(env);
  const research = researchConfigFromEnv(env);
  const fallback = apiFallbackConfigFromEnv(env);
  const meta = metaConfigFromEnv(env);
  const metaSummary = metaSummaryConfigFromEnv(env);
  const rule = STUDY_CAPTURE_RULE;
  const onOff = (b: boolean) => (b ? "on" : "off");
  return [
    "[config]",
    `judge_min_signals=${judge.minSignals}`,
    `judge_runs_24h=${judge.maxRunsPerDay}`,
    `propose_new_24h=${propose.maxNewPerDay}`,
    `propose_runs_24h=${propose.maxRunsPerDay}`,
    `daily_quota_usd=${research.dailyQuotaUsd}`,
    `research_share=${research.share}`,
    `api_fallback=${onOff(fallback.enabled)}`,
    `api_key=${facts.apiKeySet ? "set" : "unset"}`,
    `study=${onOff(facts.studyOn)}`,
    `study_rule=v${rule.version}`,
    `study_age_s=${rule.snapshotAgeSec}/${rule.xCaptureAgeSec}`,
    `study_captures_day=${captureRunCap(env)}`,
    `meta_every_min=${metaIntervalMinutes(env)}`,
    `meta_rank=${meta.rankOrder.join(",")}`,
    `meta_dex=${meta.dexGroups}/${meta.dexMaxCalls}`,
    `meta_summary_runs_24h=${metaSummary.maxRunsPerDay}`,
    `meta_summary_usd_24h=${metaSummary.maxDailyUsd}`,
    `telegram=${onOff(facts.telegramOn)}`,
  ].join(" ");
}
