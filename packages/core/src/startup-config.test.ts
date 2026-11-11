import { describe, expect, it } from "vitest";
import { startupConfigLine } from "./index.ts"; // via the barrel: judge.ts reaches datastore.ts, whose import cycle only resolves from the entry point

describe("startupConfigLine", () => {
  it("states the effective defaults on one greppable line", () => {
    const line = startupConfigLine({}, { apiKeySet: false, telegramOn: false, studyOn: true });
    expect(line).toBe(
      "[config] judge_min_signals=2 judge_runs_24h=300 propose_new_24h=30 propose_runs_24h=45 daily_quota_usd=20 research_share=0.3 api_fallback=off api_key=unset study=on study_rule=v1 study_age_s=60/300 study_captures_day=20000 meta_every_min=15 meta_rank=creators,migrationsAfter60s,marketCapUsd,tokens meta_dex=10/20 meta_summary_runs_24h=40 meta_summary_usd_24h=0.25 telegram=off",
    );
    expect(line).not.toContain("\n");
  });

  it("reports env overrides", () => {
    const line = startupConfigLine(
      { ARGUS_JUDGE_MIN_SIGNALS: "3", ARGUS_JUDGE_MAX_RUNS_PER_DAY: "100", ARGUS_PROPOSE_MAX_NEW_PER_DAY: "5", ARGUS_PROPOSE_MAX_RUNS_PER_DAY: "9", ARGUS_DAILY_QUOTA_USD: "10", ARGUS_RESEARCH_SHARE: "0.5", ARGUS_API_FALLBACK: "1", ARGUS_STUDY_CAPTURES_PER_DAY: "500", ARGUS_META_INTERVAL_MINUTES: "30", ARGUS_META_RANK_ORDER: "tokens,creators", ARGUS_META_SUMMARY_MAX_PER_DAY: "10", ARGUS_META_SUMMARY_MAX_DAILY_USD: "0.1" },
      { apiKeySet: true, telegramOn: true, studyOn: false },
    );
    for (const part of ["meta_every_min=30", "meta_rank=tokens,creators", "meta_summary_runs_24h=10", "meta_summary_usd_24h=0.1"]) {
      expect(line).toContain(part);
    }
    for (const part of ["judge_min_signals=3", "judge_runs_24h=100", "propose_new_24h=5", "propose_runs_24h=9", "daily_quota_usd=10", "research_share=0.5", "api_fallback=on", "api_key=set", "study=off", "study_captures_day=500", "telegram=on"]) {
      expect(line).toContain(part);
    }
  });

  it("never contains a secret value", () => {
    const secrets = ["sk-ant-FAKEKEY-123456", "999:FAKE-BOT-TOKEN", "-100FAKECHAT"];
    const line = startupConfigLine(
      { ANTHROPIC_API_KEY: secrets[0], TELEGRAM_BOT_TOKEN: secrets[1], TELEGRAM_CHAT_ID: secrets[2], ARGUS_API_FALLBACK: "1" },
      { apiKeySet: true, telegramOn: true, studyOn: true },
    );
    for (const s of secrets) expect(line).not.toContain(s);
    expect(line).toContain("api_key=set");
    expect(line).toContain("telegram=on");
  });
});
