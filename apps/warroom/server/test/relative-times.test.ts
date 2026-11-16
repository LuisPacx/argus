import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNoticeView, checkedAge } from "../../app/utils/build-notice.ts";
import { fmtUtc, fmtUtcClock } from "../../app/utils/format.ts";
import { ideaViews, memeView, type MemeProposalPayload, type MetaIdeaPayload } from "../../app/utils/meme.ts";
import { ageText, currentMetaView, metaView, type CurrentMetaPayload, type MetaPayload } from "../../app/utils/meta.ts";
import { newMetaView, type NewMetaPayload } from "../../app/utils/new-meta.ts";

/**
 * Relative times (War Room ticket 15). The server render and the first client render both run with a clock of 0, so the text must be the
 * same whatever Date.now() says, and must not say "ago". With a real clock the text is the relative form.
 */
const at = (iso: string) => Date.parse(iso);
const T = "2026-11-06T23:49:30.000Z";
const counts = { "6h": { tokens: 10, creators: 5, migrations: 1 }, "24h": { tokens: 40, creators: 20, migrations: 3 } };
const leader = { name: "Jensen Huang", symbol: "JENSEN", marketCapUsd: 2_400_000 };
const idea: MetaIdeaPayload = { id: 3, name: "Idea", ticker: "IDEA", angle: "a joke", status: "new", riskLabels: [], expiresAt: "2026-11-17T04:10:00.000Z" };
const current: CurrentMetaPayload = {
  computedAt: T,
  metas: [{ label: "Jensen", leader, enteredAt: T, counts, topTokens: [], summary: "s", newMeta: { reason: "became a Meta", raisedAt: T }, ideas: [idea] }],
  watching: [{ label: "Watched", leader, enteredAt: T, counts, topTokens: [], summary: "s" }],
};
const metas: MetaPayload = { computedAt: T, metas: [{ rank: 1, label: "Jensen", firstSeenAt: T, counts, createsPerMigration: null, topTokens: [], summary: "s" }] };
const newMetas: NewMetaPayload = {
  computedAt: T,
  items: [{ reason: "became a Meta", raisedAt: T, meta: { label: "Jensen", summary: "s", counts, topTokens: [] }, news: [{ title: "Headline", sourceLabel: "Wired", url: "https://example.com/a", publishedAt: T }] }],
};
const meme = {
  kind: "meme",
  name: "Idea",
  ticker: "IDEA",
  metaSnapshot: {
    version: 2,
    capturedAt: T,
    meta: { key: "jensen", label: "Jensen", rank: 1, firstSeenAt: T, counts, topTokens: [] },
    leader,
    trigger: { kind: "new", reason: "became a Meta", at: T },
    run: { id: 1, computedAt: T },
    news: [{ title: "Headline", sourceLabel: "Wired", url: "https://example.com/a", publishedAt: T }],
  },
} as unknown as MemeProposalPayload;
const approved = { status: "approved", buildRefusal: { code: "x", message: "no image", at: T }, buildRunning: false, buildRetrySeconds: 30 };

const views = (nowMs: number) => ({
  index: [currentMetaView(current, nowMs), newMetaView(newMetas, nowMs)],
  meta: [metaView(metas, nowMs, { rows: 50 }), currentMetaView(current, nowMs), newMetaView(newMetas, nowMs)],
  proposal: [memeView(meme, nowMs), buildNoticeView(approved, nowMs)],
});

afterEach(() => vi.useRealTimers());

describe("the clock before mount (nowMs = 0)", () => {
  for (const page of ["index", "meta", "proposal"] as const) {
    it(`/${page}: the same text whichever minute Date.now() is, and no "ago"`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(at("2026-11-16T10:00:10.000Z"));
      const first = JSON.stringify(views(0)[page]);
      vi.setSystemTime(at("2026-11-16T10:01:10.000Z"));
      const second = JSON.stringify(views(0)[page]);
      expect(second).toBe(first);
      expect(first).not.toMatch(/ ago|closes in|Expires in/);
      expect(first).toContain("6 Nov 23:49 UTC");
    });
  }

  it("with a real clock the text is the relative form", () => {
    const now = at("2026-11-07T01:49:30.000Z");
    expect(JSON.stringify(views(now).index)).toContain("2 hours ago");
    expect(JSON.stringify(views(now).proposal)).toContain("2 hours ago");
    expect(JSON.stringify(views(now).proposal)).toContain("last checked 2 h ago");
  });

  it("ageText, ideaViews and checkedAge give absolute UTC text, whatever TZ is", () => {
    const old = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
        process.env.TZ = tz;
        expect(ageText(T, 0)).toBe("6 Nov 23:49 UTC");
        expect(ideaViews([idea], 0)[0]?.expires).toBe("closes 17 Nov 04:10 UTC");
        expect(checkedAge(T, 0)).toBe("23:49:30 UTC");
      }
    } finally {
      if (old === undefined) delete process.env.TZ;
      else process.env.TZ = old;
    }
    expect(ageText("nope", 0)).toBeNull();
    expect(fmtUtc("nope")).toBe("");
    expect(fmtUtcClock("nope")).toBe("");
  });

  it("the stale note waits for the clock", () => {
    expect(metaView({ ...metas, computedAt: "2020-01-01T00:00:00.000Z" }, 0).state).not.toBe("stale");
    expect(metaView({ ...metas, computedAt: "2020-01-01T00:00:00.000Z" }, at("2026-11-16T10:00:00.000Z")).state).toBe("stale");
    expect(currentMetaView({ ...current, computedAt: "2020-01-01T00:00:00.000Z" }, 0).state).toBe("ok");
  });
});

describe("no clock reads where the text is built", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/${p}`, import.meta.url), "utf8");
  for (const f of ["meta", "meme", "new-meta", "build-notice"]) {
    it(`utils/${f}.ts has no Date.now() or new Date()`, () => {
      expect(read(`utils/${f}.ts`)).not.toMatch(/Date\.now\(|new Date\(/);
    });
  }
  for (const f of ["index.vue", "meta.vue", "narratives/index.vue", "proposals/[id].vue", "activity.vue"]) {
    it(`pages/${f} takes its clock from useNowMs and never from Date.now()`, () => {
      const src = read(`pages/${f}`);
      expect(src).toContain("useNowMs(");
      expect(src).not.toMatch(/Date\.now\(/);
    });
  }
});
