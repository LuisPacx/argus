import { readFileSync } from "node:fs";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { fmtCount, momentsPageView, postHref, POST_TEXT_CLAMP, resumeFailure, type MomentsPayload, type MomentsPayloadPost } from "../../app/utils/moments.ts";

/** The Moments list: the real MomentsPanel.vue template, server-rendered over a payload typed as the API's own response. */
const NOW = Date.parse("2026-11-19T16:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ID = "2123280111864811617";

const row = (over: Partial<MomentsPayloadPost> = {}): MomentsPayloadPost => ({ statusId: ID, handle: "alice", url: `https://x.com/alice/status/${ID}`, text: "A rising clip", postedAt: ago(180), views: 620_000, likes: 12_400, viewsPerHour: 206_000, recentRate: 390_000, readings: 3, lastSeenAt: ago(5), ...over });
const payload = (over: Partial<MomentsPayload> = {}, posts: MomentsPayloadPost[] = [row()]): MomentsPayload => ({
  enabled: true,
  topic: "GTA VI",
  scanner: { lastScanAt: ago(5), lastStatus: "ok", lastReason: "", lastLoads: 2, lastGoodScanAt: ago(5) },
  session: { status: "ok", reason: "", stoppedAt: null, resumeAt: null, probeDue: false },
  posts,
  ...over,
});
const stopped = (over: Partial<MomentsPayload["session"]> = {}): MomentsPayload["session"] => ({ status: "stopped", reason: "login_wall", stoppedAt: ago(90), resumeAt: new Date(NOW + 8 * 3_600_000).toISOString(), probeDue: false, ...over });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderPanel = await load("MomentsPanel.vue");

async function draw(p: MomentsPayload | null, nowMs = NOW, over: Record<string, unknown> = {}): Promise<string> {
  const view = momentsPageView(p, nowMs);
  const app = createSSRApp({ render: () => renderPanel({ view, busy: false, error: null, resume: () => {}, ...over }, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  return renderToString(app);
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

describe("a rising clip", () => {
  it("is one row with the link to the post, the handle, the text, views, likes, views an hour, the recent rate, the age and the readings", async () => {
    const html = await draw(payload());
    expect(html).toContain(`data-test="moment-${ID}"`);
    expect(hrefs(html)).toEqual([`https://x.com/alice/status/${ID}`]);
    for (const text of ["@alice", "A rising clip", "620K views", "12.4K likes", "206K views an hour", "recent 390K an hour", "posted 3 hours ago", "3 readings", "Last good scan 5 minutes ago.", "Topic: GTA VI.", "X session: ok"]) expect(html, text).toContain(text);
    expect(html).not.toContain('data-test="moments-empty"');
    expect(html).not.toContain('data-test="x-resume"');
    expect(html).not.toMatch(/undefined|NaN|null/);
  });

  it("shows no recent rate when there is no earlier reading, and 'no rate yet' when the post does not rate", async () => {
    const html = await draw(payload({}, [row({ recentRate: null, readings: 1 }), row({ statusId: "2123280111864811000", viewsPerHour: null, views: null })]));
    expect(html.match(/data-test="moment-recent"/g)).toHaveLength(1);
    expect(html).toContain("1 reading");
    expect(html).toContain("no rate yet");
    expect(html).toContain("n/a views");
  });

  it("keeps the order the API gave: newest reading first", async () => {
    const html = await draw(payload({}, [row({ statusId: "2123280111864811001", handle: "first" }), row({ statusId: "2123280111864811002", handle: "second" })]));
    expect(html.indexOf("@first")).toBeLessThan(html.indexOf("@second"));
  });

  it("each row has an anchor id for #post-<id>", async () => {
    expect(await draw(payload())).toContain(`id="post-${ID}"`);
  });
});

describe("hostile text", () => {
  const EVIL = `<img src=x onerror=1>\n<script>alert(1)</script> javascript:alert(1) ‮${"A".repeat(100_000)}`;

  it("a post's text renders as one clamped line of escaped text", async () => {
    const html = await draw(payload({}, [row({ text: EVIL })]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("‮");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("A".repeat(300));
    expect(html).toContain("…");
    expect(html.length).toBeLessThan(8_000);
    const shown = html.match(/data-test="moment-text">([^<]*)</)![1]!;
    expect(shown).not.toContain("\n");
    expect([...shown].length).toBeLessThanOrEqual(POST_TEXT_CLAMP + 40); // the cut line, with the escapes of < and > counted in
    expect(momentsPageView(payload({}, [row({ text: EVIL })]), NOW).rows[0]!.text.length).toBeLessThanOrEqual(POST_TEXT_CLAMP + 1);
  });

  it("a handle, topic or reason with markup is text too", async () => {
    const p = payload({ topic: EVIL, scanner: { lastScanAt: ago(5), lastStatus: "skipped", lastReason: EVIL, lastLoads: 0, lastGoodScanAt: null } }, []);
    const html = await draw(p);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    const hostileHandle = await draw(payload({}, [row({ handle: "<b>x</b>" })]));
    expect(hostileHandle).not.toContain("<b>");
    expect(hostileHandle).toContain("@");
  });

  it.each([
    ["a javascript: address", "javascript:alert(1)"],
    ["a data: address", "data:text/html,<script>alert(1)</script>"],
    ["another site", `https://evil.example/alice/status/${ID}`],
    ["a look-alike host", `https://x.com.evil.example/alice/status/${ID}`],
    ["a subdomain", `https://mobile.x.com/alice/status/${ID}`],
    ["a profile page", "https://x.com/alice"],
    ["http", `http://x.com/alice/status/${ID}`],
    ["credentials", `https://user:pw@x.com/alice/status/${ID}`],
    ["a port", `https://x.com:444/alice/status/${ID}`],
    ["a query", `https://x.com/alice/status/${ID}?s=20`],
    ["a fragment", `https://x.com/alice/status/${ID}#x`],
    ["a path after the ID", `https://x.com/alice/status/${ID}/analytics`],
    ["a short ID", "https://x.com/alice/status/123"],
    ["not text", 5 as unknown as string],
  ])("a stored link that is %s is never an anchor", async (_name, url) => {
    expect(postHref(url)).toBeNull();
    const html = await draw(payload({}, [row({ url })]));
    expect(html).not.toMatch(/<a[\s>]|href=/);
    expect(html).toContain("@alice"); // the handle still shows, as text
  });

  it("accepts exactly an https://x.com/<handle>/status/<id> address", () => {
    expect(postHref(`https://x.com/alice/status/${ID}`)).toBe(`https://x.com/alice/status/${ID}`);
    expect(postHref(` https://x.com/Some_One1/status/${ID} `)).toBe(`https://x.com/Some_One1/status/${ID}`);
  });
});

describe("the empty states say why", () => {
  const nothing = (over: Partial<MomentsPayload> = {}) => payload(over, []);
  const say = async (p: MomentsPayload | null) => {
    const html = await draw(p);
    expect(html).toContain('data-test="moments-empty"');
    return html;
  };

  it("off", async () => {
    expect(await say(nothing({ enabled: false, topic: null, scanner: { lastScanAt: null, lastStatus: null, lastReason: "", lastLoads: 0, lastGoodScanAt: null } }))).toContain("The Moment scanner is off");
  });
  it("no scan yet", async () => {
    expect(await say(nothing({ scanner: { lastScanAt: null, lastStatus: null, lastReason: "", lastLoads: 0, lastGoodScanAt: null } }))).toContain("No scan yet");
  });
  it("busy: the last scan was skipped because the browser was in use", async () => {
    const html = await say(nothing({ scanner: { lastScanAt: ago(2), lastStatus: "skipped", lastReason: "browser busy", lastLoads: 0, lastGoodScanAt: ago(32) } }));
    expect(html).toContain("The last scan was skipped: browser busy");
    expect(html).toContain("Last good scan 32 minutes ago.");
  });
  it("stopped for the day, with the signal", async () => {
    const html = await say(nothing({ session: stopped() }));
    expect(html).toContain("Stopped for the day: X showed login_wall");
    expect(html).toContain("X session: stopped on login_wall, 1 hour ago");
    expect(html).toContain("Nothing loads from X until 00:00 UTC");
  });
  it("nothing rising", async () => {
    expect(await say(nothing())).toContain("Nothing is rising right now in GTA VI");
  });
  it("the last scan failed", async () => {
    expect(await say(nothing({ scanner: { lastScanAt: ago(2), lastStatus: "selectors_found_nothing", lastReason: "a page had no readable posts", lastLoads: 1, lastGoodScanAt: ago(60) } }))).toContain("The last scan did not finish: a page had no readable posts");
  });
  it("the list could not be loaded at all", async () => {
    expect(await say(null)).toContain("The Moments list could not be loaded.");
  });
});

describe("the Resume button", () => {
  it("shows only while the X session is stopped, and says what happens next", async () => {
    const waiting = await draw(payload({ session: stopped() }, []));
    expect(waiting.match(/data-test="x-resume"/g)).toHaveLength(1);
    expect(waiting).toContain(">Resume X jobs<");
    expect(waiting).toContain("Nothing loads from X until 00:00 UTC; then one probe load decides whether to go on.");
    for (const p of [payload(), payload({}, [])]) expect(await draw(p)).not.toContain("x-resume");
  });

  it("when the second stop within 7 days leaves no resume time it says only Resume clears it; when a probe is due it says so", async () => {
    expect(await draw(payload({ session: stopped({ resumeAt: null }) }))).toContain("second stop within 7 days");
    expect(await draw(payload({ session: stopped({ probeDue: true, resumeAt: ago(60) }) }))).toContain("makes one probe load");
  });

  it("a stopped session still lists the rows it has, with the button above them", async () => {
    const html = await draw(payload({ session: stopped() }));
    expect(html).toContain("@alice");
    expect(html.indexOf("x-resume")).toBeLessThan(html.indexOf("@alice"));
  });

  it("the server's reason for a refused press shows as text; a busy button is disabled", async () => {
    const html = await draw(payload({ session: stopped() }), NOW, { error: "The X session is not stopped: there is nothing to resume <b>", busy: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain("nothing to resume &lt;b&gt;");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("Resuming…");
  });

  it("resumeFailure gives the server's statusMessage as one line, whatever the error looks like", () => {
    expect(resumeFailure({ data: { statusMessage: "The X session is not stopped" } })).toBe("The X session is not stopped");
    expect(resumeFailure({ statusMessage: "x\n".repeat(500) }).length).toBeLessThanOrEqual(201);
    expect(resumeFailure(new Error("boom"))).toBe("The request failed. Try again.");
    expect(resumeFailure(null)).toBe("The request failed. Try again.");
  });
});

describe("the page before mount (the clock is 0)", () => {
  it("shows absolute UTC times and no relative ones, so the server and the first client render agree", async () => {
    const html = await draw(payload({ session: stopped() }), 0);
    expect(html).toContain("UTC");
    expect(html).not.toMatch(/ago/);
  });
});

describe("numbers", () => {
  it("fmtCount reads K, M and B, a plain number below 1,000, and n/a for a missing figure", () => {
    expect([fmtCount(640), fmtCount(18_900), fmtCount(1_200_000), fmtCount(2_500_000_000), fmtCount(null), fmtCount(Number.NaN)]).toEqual(["640", "18.9K", "1.2M", "2.5B", "n/a", "n/a"]);
  });
});

describe("no raw HTML", () => {
  it.each(["components/MomentsPanel.vue", "pages/moments.vue"])("%s has no v-html and no raw anchor", (file) => {
    const src = readFileSync(new URL(`../../app/${file}`, import.meta.url), "utf8");
    expect(src).not.toContain("v-html");
    expect(src).not.toMatch(/<a[\s>]|\shref=/);
  });
  it("the panel's only external link is UrlLink", () => {
    expect(readFileSync(new URL("../../app/components/MomentsPanel.vue", import.meta.url), "utf8")).toContain("<UrlLink");
  });
});
