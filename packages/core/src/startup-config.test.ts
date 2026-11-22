import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTokenFilePresent, startupConfigLine, type StartupFacts } from "./index.ts"; // via the barrel: judge.ts reaches datastore.ts, whose import cycle only resolves from the entry point
import { tempDir } from "./testing/temp.ts";

const BUILD = { buildDryRun: false, buildImage: "localhost/argus-build:cc-1", buildCloudflare: true, buildTokenPresent: true };
const facts = (over: Partial<StartupFacts> = {}): StartupFacts => ({ apiKeySet: false, telegramOn: false, studyOn: true, ...BUILD, ...over });

describe("startupConfigLine", () => {
  it("states the effective defaults on one greppable line", () => {
    const line = startupConfigLine({}, facts());
    expect(line).toBe(
      "[config] judge_min_signals=2 judge_runs_24h=300 propose_new_24h=30 propose_runs_24h=45 daily_quota_usd=20 research_share=0.3 api_fallback=off api_key=unset study=on study_rule=v1 study_age_s=60/300 study_captures_day=20000 meta_every_min=15 meta_rank=creators,migrationsAfter60s,marketCapUsd,tokens meta_dex=10/20 meta_grads=10/5/6/3 meta_watch_grads=5/3 meta_max=3/3 meta_leader_calls=4 meta_topdown=5/50000/50000 meta_state_min=120 meta_summary_runs_24h=40 meta_summary_usd_24h=0.25 meta_group=ai/$1.00 meme_ideas=off meme_runs_24h=24 build_dry_run=off build_image=localhost/argus-build:cc-1 build_cloudflare=yes build_token=present telegram=off",
    );
    expect(line).not.toContain("\n");
  });

  it("reports the graduation Meta knobs, and a stay above enter keeps both defaults", () => {
    const set = { ARGUS_META_MIN_GRADS: "12", ARGUS_META_STAY_GRADS: "6", ARGUS_META_GRAD_CREATORS: "8", ARGUS_META_LIVE_GRADS_6H: "4", ARGUS_META_WATCH_MIN_GRADS: "7", ARGUS_META_WATCH_GRADS_6H: "2", ARGUS_META_MAX_METAS: "2", ARGUS_META_WATCHING: "4", ARGUS_META_LEADER_CALLS: "6", ARGUS_META_STATE_MAX_MINUTES: "90" };
    for (const part of ["meta_grads=12/6/8/4", "meta_watch_grads=7/2", "meta_max=2/4", "meta_leader_calls=6", "meta_state_min=90"]) expect(startupConfigLine(set, facts())).toContain(part);
    expect(startupConfigLine({ ARGUS_META_MIN_GRADS: "8", ARGUS_META_STAY_GRADS: "9" }, facts())).toContain("meta_grads=10/5/6/3");
  });

  it("reports the top-down knobs (calls, minimum liquidity, minimum volume), and junk keeps the defaults", () => {
    const set = { ARGUS_META_TOPDOWN_CALLS: "3", ARGUS_META_TOPDOWN_MIN_LIQ_USD: "80000", ARGUS_META_TOPDOWN_MIN_VOLUME_USD: "20000", ARGUS_META_TOPDOWN_MAX_CAP_LIQ_RATIO: "50" };
    expect(startupConfigLine(set, facts())).toContain("meta_topdown=3/80000/20000");
    expect(startupConfigLine({ ARGUS_META_TOPDOWN_CALLS: "0", ARGUS_META_TOPDOWN_MIN_LIQ_USD: "lots", ARGUS_META_TOPDOWN_MIN_VOLUME_USD: "-1" }, facts())).toContain("meta_topdown=5/50000/50000");
  });

  it("reports env overrides", () => {
    const line = startupConfigLine(
      { ARGUS_JUDGE_MIN_SIGNALS: "3", ARGUS_JUDGE_MAX_RUNS_PER_DAY: "100", ARGUS_PROPOSE_MAX_NEW_PER_DAY: "5", ARGUS_PROPOSE_MAX_RUNS_PER_DAY: "9", ARGUS_DAILY_QUOTA_USD: "10", ARGUS_RESEARCH_SHARE: "0.5", ARGUS_API_FALLBACK: "1", ARGUS_STUDY_CAPTURES_PER_DAY: "500", ARGUS_META_INTERVAL_MINUTES: "30", ARGUS_META_RANK_ORDER: "tokens,creators", ARGUS_META_SUMMARY_MAX_PER_DAY: "10", ARGUS_META_SUMMARY_MAX_DAILY_USD: "0.1" },
      facts({ apiKeySet: true, telegramOn: true, studyOn: false }),
    );
    for (const part of ["meta_every_min=30", "meta_rank=tokens,creators", "meta_summary_runs_24h=10", "meta_summary_usd_24h=0.1"]) {
      expect(line).toContain(part);
    }
    for (const part of ["judge_min_signals=3", "judge_runs_24h=100", "propose_new_24h=5", "propose_runs_24h=9", "daily_quota_usd=10", "research_share=0.5", "api_fallback=on", "api_key=set", "study=off", "study_captures_day=500", "telegram=on"]) {
      expect(line).toContain(part);
    }
  });

  it("states the meme ideas switch and its cap (off by default, on only for 1)", () => {
    expect(startupConfigLine({ ARGUS_MEME_IDEAS: "1", ARGUS_MEME_MAX_PER_DAY: "10" }, facts())).toContain("meme_ideas=on meme_runs_24h=10");
    expect(startupConfigLine({ ARGUS_MEME_IDEAS: "0" }, facts())).toContain("meme_ideas=off meme_runs_24h=24");
    expect(() => startupConfigLine({ ARGUS_MEME_IDEAS: "yes" }, facts())).toThrow(/ARGUS_MEME_IDEAS/);
  });

  it("never contains a secret value", () => {
    const secrets = ["sk-ant-FAKEKEY-123456", "999:FAKE-BOT-TOKEN", "-100FAKECHAT"];
    const line = startupConfigLine(
      { ANTHROPIC_API_KEY: secrets[0], TELEGRAM_BOT_TOKEN: secrets[1], TELEGRAM_CHAT_ID: secrets[2], ARGUS_API_FALLBACK: "1" },
      facts({ apiKeySet: true, telegramOn: true }),
    );
    for (const s of secrets) expect(line).not.toContain(s);
    expect(line).toContain("api_key=set");
    expect(line).toContain("telegram=on");
  });

  it("states the Build fields in each state", () => {
    expect(startupConfigLine({}, facts({ buildDryRun: true, buildCloudflare: false, buildTokenPresent: false, buildImage: "my/image:tag" }))).toContain(
      "build_dry_run=on build_image=my/image:tag build_cloudflare=no build_token=absent",
    );
  });

  it("build_token is present only for a file, and neither it nor build_cloudflare ever carries a secret", () => {
    const dir = tempDir("argus-startup-");
    const file = join(dir, "token");
    const SECRET = "sk-ant-oat01-SECRET-TOKEN-CONTENT";
    writeFileSync(file, `${SECRET}\n`, { mode: 0o644 });
    mkdirSync(join(dir, "adir"));
    expect(buildTokenFilePresent(file)).toBe(true);
    expect(buildTokenFilePresent(join(dir, "absent"))).toBe(false);
    expect(buildTokenFilePresent(join(dir, "adir"))).toBe(false);
    const env = { CLOUDFLARE_ACCOUNT_ID: "acct-SECRET-ID", CLOUDFLARE_API_TOKEN: "cf-SECRET-TOKEN", ARGUS_BUILD_TOKEN_FILE: file };
    const line = startupConfigLine(env, facts({ buildTokenPresent: buildTokenFilePresent(file) }));
    for (const s of [SECRET, "acct-SECRET-ID", "cf-SECRET-TOKEN", file]) expect(line).not.toContain(s);
    expect(line).toMatch(/ build_token=(present|absent) /);
    expect(line).toMatch(/ build_cloudflare=(yes|no) /);
  });
});
