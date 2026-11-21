import { readFileSync } from "node:fs";
import type { CurrentMetaApiRow, CurrentMetaResponse } from "@argus/core";
import { createSSRApp, h } from "vue";
import { compileTemplate, parse } from "vue/compiler-sfc";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { currentMetaView } from "../../app/utils/meta.ts";
import { ANGLE_MAX_CHARS, angleCanSubmit, angleCounter, angleStatusFor, failureReason, submitAngle, type AngleRequestPayload } from "../../app/utils/angle.ts";

/** The Current Meta section: the real CurrentMeta.vue template, server-rendered over fixtures typed as the API's own response. */
const NOW = Date.parse("2026-11-15T20:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const counts = (tokens: number, creators: number) => ({ "6h": { tokens: Math.floor(tokens / 3), creators: Math.floor(creators / 3), migrations: 0, migrationsAfter60s: 0 }, "24h": { tokens, creators, migrations: 2, migrationsAfter60s: 1 } });

const subject = (label: string, symbol: string, cap: number, over: Partial<CurrentMetaApiRow> = {}): CurrentMetaApiRow => ({
  key: label.toLowerCase(),
  label,
  namedBy: "rules",
  themes: [],
  leader: { mint: "M1", name: label, symbol, marketCapUsd: cap, stale: false, url: `https://dexscreener.com/solana/${symbol}` },
  holding: false,
  enteredAt: ago(3 * 60),
  counts: counts(60, 45),
  topTokens: [{ mint: "T1", name: "Sidekick", symbol: "SIDE", marketCapUsd: 90_000 }],
  summary: `${label} is the story today`,
  summarySource: "llm",
  ...over,
});
const response = (metas: CurrentMetaApiRow[], watching: CurrentMetaApiRow[], computedAt: string | null = ago(8), coverageNote: string | null = null): CurrentMetaResponse => ({ computedAt, coverageNote, metas, watching });

const JENSEN = subject("Jensen Huang", "JENSEN", 2_400_000, { ideas: [{ id: 5, name: "Empty Chair", ticker: "CHAIR", angle: "The joke", status: "new", riskLabels: ["real person"], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString() }] });
const GTA = subject("GTA 6", "GTA", 1_100_000, { holding: true });
const W1 = subject("Lucia From GTA 6", "LUCIA", 400_000);
const W2 = subject("Jensen Huang", "JENSEN", 90_000, { counts: counts(0, 0) });
const W3 = subject("Nyajira", "NYA", 60_000, { leader: { mint: "M3", name: "Nyajira", symbol: "NYA", marketCapUsd: 60_000, stale: true } });

type Render = (ctx: unknown, cache: unknown[]) => unknown;
async function load(file: string): Promise<Render> {
  const sfc = parse(readFileSync(new URL(`../../app/components/${file}`, import.meta.url), "utf8"));
  const compiled = compileTemplate({ source: sfc.descriptor.template!.content, filename: file, id: file });
  return new Function("Vue", `${compiled.code.replace(/import \{([^}]*)\} from "vue"/, (_m, names: string) => `const {${names.replaceAll(" as ", ": ")}} = Vue`).replace("export function render", "return function render")}`)(await import("vue")) as Render;
}
const renderCurrent = await load("CurrentMeta.vue");
const renderForm = await load("AngleForm.vue");

function mount(render: Render, ctx: Record<string, unknown>, withForm: boolean) {
  const app = createSSRApp({ render: () => render(ctx, []) as ReturnType<typeof h> });
  app.component("UrlLink", { props: ["href", "label"], render() { return h("a", { class: "url-link", href: this.href }, this.label); } });
  app.component("NuxtLink", { props: ["to"], render() { return h("a", { class: "nuxt-link", href: this.to }, this.$slots.default?.()); } });
  // In the section the real form is replaced by a marker that shows what the section handed it: the key and the status line.
  if (withForm) app.component("AngleForm", { props: ["metaKey", "status"], render() { return h("div", { "data-test": "angle-form-stub", "data-key": this.metaKey }, (this.status as { text?: string } | null)?.text ?? "no status"); } });
  return app;
}

async function draw(payload: CurrentMetaResponse | null, home = false, nowMs = NOW, angles?: AngleRequestPayload[]): Promise<string> {
  return renderToString(mount(renderCurrent, { view: currentMetaView(payload, nowMs, angles), home }, true));
}

it("2 Metas and 3 Watching: each Meta shows its leader, cap, copies, since, summary, tokens and ideas; each Watching row says it is not a Meta and has no ideas", async () => {
  const html = await draw(response([JENSEN, GTA], [W1, W2, W3]));
  expect(html).toContain('data-test="current-meta-1"');
  expect(html).toContain('data-test="current-meta-2"');
  expect(html).not.toContain('data-test="current-meta-3"');
  for (const text of ["Jensen Huang", "Jensen Huang ($JENSEN)", "$2.4M", "45 creators copying in 24 h", "Meta since 3 hours ago", "Jensen Huang is the story today", "Sidekick ($SIDE) $90K", "Empty Chair", "Meme ideas", "computed 8 minutes ago"]) expect(html, text).toContain(text);
  expect(html).toContain('href="https://dexscreener.com/solana/JENSEN"');
  expect(html).not.toContain('data-test="meta-empty"');
  expect(html.match(/data-test="watching-\d"/g)).toHaveLength(3);
  expect(html.match(/Watching, not a Meta/g)).toHaveLength(3);
  expect(html).toContain("Not a Meta: a token is up but has not reached the entry market cap.");
  expect(html).toContain("Watching since 3 hours ago");
  expect(html).toContain("no copies launched in 24 h"); // W2
  expect(html.slice(html.indexOf('data-test="watching"'))).not.toContain("Meme ideas");
  expect(html).not.toMatch(/undefined|NaN|null/);
});

it("no Meta and 2 Watching: 'No Meta right now' stays and the Watching list shows", async () => {
  const html = await draw(response([], [W1, W3]));
  expect(html).toContain('data-test="meta-empty"');
  expect(html).toContain("No Meta right now");
  expect(html).not.toContain('data-test="metas"');
  expect(html.match(/data-test="watching-\d"/g)).toHaveLength(2);
  expect(html.indexOf("No Meta right now")).toBeLessThan(html.indexOf("Lucia From GTA 6"));
});

it("a run with nothing at all says 'No Meta right now' and no Watching block", async () => {
  const html = await draw(response([], []));
  expect(html).toContain("No Meta right now");
  expect(html).not.toContain('data-test="watching"');
});

it("before the first run (waiting) it shows one line and neither Metas, Watching nor 'No Meta right now'", async () => {
  for (const payload of [null, response([], [], null)]) {
    const html = await draw(payload);
    expect(html).toContain("No Meta run yet. The worker computes it every 15 minutes.");
    expect(html).not.toMatch(/No Meta right now|data-test="metas"|data-test="watching"/);
  }
});

it("a stale run (older than 2 h) says so and still shows its rows", async () => {
  const html = await draw(response([JENSEN], [W1], ago(5 * 60)));
  expect(html).toContain('class="note note-amber"');
  expect(html).toContain("The Meta run is stale (computed 5 hours ago).");
  expect(html).toContain('data-test="current-meta-1"');
  expect(await draw(response([JENSEN], []))).not.toContain("stale");
});

it("a holding Meta carries the cooling pill and says why; a stale leader cap says it is from the last answer; a normal Meta has neither", async () => {
  const cooling = await draw(response([GTA], []));
  expect(cooling).toContain('data-test="current-cooling"');
  expect(cooling).toContain(">cooling<");
  expect(cooling).toContain("Cooling: its leading token is below the market cap that makes a Meta, but still above the one that keeps it.");
  const old = await draw(response([subject("Old", "OLD", 3_000_000, { leader: { mint: "M", name: "Old", symbol: "OLD", marketCapUsd: 3_000_000, stale: true } })], []));
  expect(old).toContain("(cap as of the last answer)");
  const plain = await draw(response([JENSEN], [W3]));
  expect(plain).not.toContain("current-cooling");
  expect(plain.match(/cap as of the last answer/g)).toHaveLength(1); // only W3's leader is stale
});

it("the coverage note shows when the API sends one", async () => {
  expect(await draw(response([JENSEN], [], ago(8), "Only 1 h of data in the last 24 h"))).toContain("Only 1 h of data in the last 24 h");
  expect(await draw(response([JENSEN], []))).not.toContain("meta-coverage-note");
});

it("the home variant links to /meta and to /meta#all-launch-themes; /meta itself has no such links; no launch-theme list on either", async () => {
  const home = await draw(response([JENSEN], []), true);
  expect(home).toContain('href="/meta"');
  expect(home).toContain('href="/meta#all-launch-themes"');
  expect(home).not.toContain('data-test="meta-list"');
  const page = await draw(response([JENSEN], []));
  expect(page).not.toContain('href="/meta"');
});

it("hostile labels, ticker, leader name, summary and URLs are cut and shown as text, never as markup or a link", async () => {
  const evil = `<img src=x onerror=alert(1)></script><script>alert(1)</script> javascript:alert(1) ‮${"A".repeat(5_000)}`;
  const bad = subject(evil, evil, 3_000_000, {
    key: "evil-key", // a key is the server's own normalised text, handed back to it and never shown
    leader: { mint: "x", name: evil, symbol: evil, marketCapUsd: 3_000_000, stale: false, url: "javascript:alert(1)" },
    summary: evil,
    topTokens: [{ mint: "y", name: evil, symbol: evil, marketCapUsd: 1, url: "data:text/html,<script>alert(1)</script>" }, { mint: "z", name: "cred", symbol: "C", url: "https://user:pw@evil.example/" }],
    ideas: [{ id: 9, name: evil, ticker: evil, angle: evil, status: "new", riskLabels: [evil], createdAt: ago(1), expiresAt: null as never }],
  });
  const html = await draw(response([bad], [{ ...bad, ideas: undefined }]));
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("‮");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toMatch(/href="(javascript|data):/);
  expect(html).not.toContain("evil.example");
  expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/proposals/9"]); // the only link: the idea's own card
  expect(html).toContain("…");
  expect(html.length).toBeLessThan(12_000);
  expect(html).not.toContain("A".repeat(300)); // every field is cut (the longest, an idea's angle, at 300)
});

it("a Meta shows its name as the title and its merged themes under it (5 and '+N more'); Watching the same; a Meta that merged nothing shows no list", async () => {
  const th = (label: string, tokens = 10, creators = 4) => ({ label, tokens, creators });
  const merged = subject("GTA 6", "GTA", 3_000_000, { namedBy: "ai", themes: [th("Lucia From GTA 6", 270, 156), th("GTA VI"), th("Vice City")] });
  const seven = subject("Seven", "SEV", 90_000, { namedBy: "ai", themes: ["a", "b", "c", "d", "e", "f", "g"].map((l) => th(`Part ${l}`)) });
  const html = await draw(response([merged], [seven]));
  const meta = html.slice(0, html.indexOf('data-test="watching"'));
  expect(meta).toContain('data-test="current-themes"');
  expect(meta).toContain('data-test="current-themes-title">Includes<');
  expect(meta.match(/data-test="current-theme"/g)).toHaveLength(3);
  expect(meta).toContain("Lucia From GTA 6 - 270 tokens, 156 creators");
  expect(meta).not.toContain("current-themes-more");
  expect(meta).toContain('data-test="current-label">GTA 6<');
  const watching = html.slice(html.indexOf('data-test="watching"'));
  expect(watching.match(/data-test="current-theme"/g)).toHaveLength(5);
  expect(watching.match(/data-test="current-themes-more">\+2 more</g)).toHaveLength(1);
  const plain = await draw(response([JENSEN, subject("Same", "S", 3_000_000, { themes: [th("same")] })], [W1]));
  expect(plain).not.toContain("current-theme");
  expect(plain).not.toContain("Includes");
});

it("a theme label with markup is shown escaped, a very long one is cut, and no theme is a link", async () => {
  const evil = `<img src=x onerror=alert(1)>\n<script>alert(1)</script> ${"Q".repeat(100_000)}`;
  const html = await draw(response([subject("Evil", "EV", 3_000_000, { themes: [{ label: evil, tokens: 1, creators: 1 }, { label: "javascript:alert(1)", tokens: 2, creators: 2 }] })], []));
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("Q".repeat(100));
  expect(html).toContain("javascript:alert(1) - 2 tokens, 2 creators");
  const block = html.slice(html.indexOf('data-test="current-themes-block"'), html.indexOf('data-test="current-copies"'));
  expect(block).not.toMatch(/<a[\s>]|href=/);
});

it("the template has no raw HTML directive and no raw anchor; every external link is UrlLink", () => {
  const src = readFileSync(new URL("../../app/components/CurrentMeta.vue", import.meta.url), "utf8");
  expect(src).not.toContain("v-html");
  expect(src).not.toMatch(/<a[\s>]|\shref=/);
  expect(src).toContain("<UrlLink");
});

// ---- the Operator's angle (meta redesign ticket 11) ----

const req = (over: Partial<AngleRequestPayload> = {}): AngleRequestPayload => ({ id: 1, metaKey: "jensen huang", status: "pending", detail: "", createdAt: ago(3), doneAt: null, proposalIds: [], ...over });

it("on /meta each Meta and each Watching subject gets the angle form with its key and the status of its newest request; the home strip has a link and no form", async () => {
  const angles = [req({ id: 3, metaKey: "gta 6", status: "done", detail: "3 ideas", proposalIds: [7, 8, 9] }), req({ id: 2, metaKey: "jensen huang", status: "pending" }), req({ id: 1, metaKey: "jensen huang", status: "refused", detail: "an older refusal" })];
  const html = await draw(response([JENSEN, GTA], [W1]), false, NOW, angles);
  expect(html.match(/data-test="angle-form-stub"/g)).toHaveLength(3);
  expect(html).toContain('data-key="jensen huang"');
  expect(html).toContain('data-key="gta 6"');
  expect(html).toContain('data-key="lucia from gta 6"');
  expect(html).toContain("Waiting for the worker, asked 3 minutes ago."); // the newest of the two requests for Jensen
  expect(html).not.toContain("an older refusal");
  expect(html).toContain("3 ideas filed");
  expect(html).toContain("no status"); // Lucia has none
  expect(html).not.toContain('data-test="angle-link"');
  const home = await draw(response([JENSEN, GTA], [W1]), true, NOW, angles);
  expect(home).not.toContain("angle-form-stub");
  expect(home.match(/data-test="angle-link"/g)).toHaveLength(2); // one link for each Meta, none for Watching
  expect(home).toContain("Add an angle on the Meta page");
});

it("a subject without a key (an older payload) gets no form", async () => {
  const html = await draw(response([{ ...JENSEN, key: undefined as never }], []));
  expect(html).not.toContain("angle-form-stub");
});

it("an idea made from an angle carries the Angle pill; the others do not", async () => {
  const withAngle = subject("Jensen Huang", "JENSEN", 2_400_000, { ideas: [{ id: 5, name: "Empty Chair", ticker: "CHAIR", angle: "joke", status: "new", riskLabels: [], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString(), fromAngle: true }, { id: 6, name: "Plain", ticker: "PLN", angle: "joke", status: "new", riskLabels: [], createdAt: ago(10), expiresAt: new Date(NOW + 5 * 3_600_000).toISOString() }] });
  const html = await draw(response([withAngle], []));
  expect(html.match(/data-test="idea-angle-pill"/g)).toHaveLength(1);
  expect(html.slice(html.indexOf('data-test="meta-idea-5"'), html.indexOf('data-test="meta-idea-6"'))).toContain("idea-angle-pill");
});

describe("the form", () => {
  const drawForm = (over: Record<string, unknown> = {}) =>
    renderToString(
      mount(
        renderForm,
        { metaKey: "gta 6", status: null, draft: "", counter: angleCounter(""), canSubmit: false, busy: false, error: null, note: null, inputId: "angle-x", ANGLE_MAX_CHARS, submit: () => {}, ...over },
        false,
      ),
    );

  it("renders collapsed, with the textarea limited to 600 characters, a counter, one submit button, the Make ideas button and no status line when there is no request", async () => {
    const html = await drawForm();
    expect(html).toMatch(/<button[^>]*data-test="make-ideas"[^>]*>Make ideas<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*data-test="make-ideas"/);
    expect(html).toContain('data-test="angle-form"');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('data-test="angle-summary"');
    expect(html).toContain('maxlength="600"');
    expect(html).toContain('data-test="angle-counter">0 / 600<');
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("disabled");
    expect(html).not.toContain('data-test="angle-status"');
    expect(html).toContain('for="angle-x"');
  });

  it("shows the status line of the last request, the server's reason, and a note, all as text", async () => {
    const html = await drawForm({ status: { text: "Refused: no longer a Meta.", tone: "bad" }, error: "5 angle requests in 24 hours is the most (5); try again later", note: "Sent. The worker will pick it up." });
    expect(html).toContain('data-test="angle-status"');
    expect(html).toContain("Refused: no longer a Meta.");
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("is the most (5); try again later");
    expect(html).toContain("Sent. The worker will pick it up.");
  });

  it("an enabled button when the draft can be sent, and a draft with markup and newlines is escaped text in the textarea", async () => {
    const draft = "<img src=x onerror=1>\nsecond line </textarea><script>alert(1)</script>";
    const html = await drawForm({ draft, counter: angleCounter(draft), canSubmit: true });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain("&lt;/textarea&gt;");
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it("the template has no raw HTML directive and no anchor", () => {
    const src = readFileSync(new URL("../../app/components/AngleForm.vue", import.meta.url), "utf8");
    expect(src).not.toContain("v-html");
    expect(src).not.toMatch(/<a[\s>]|\shref=/);
  });

  it("Escape closes the form and returns the focus to its summary (checked in the browser by page:check --keys)", () => {
    const src = readFileSync(new URL("../../app/components/AngleForm.vue", import.meta.url), "utf8");
    expect(src).toContain('@keydown.esc="close"');
    expect(src).toContain("box.value.open = false");
    expect(src).toContain("summaryEl.value?.focus()");
  });
});

describe("the status text and the one POST (utils/angle.ts)", () => {
  const status = (r: Partial<AngleRequestPayload>) => angleStatusFor([req(r)], "jensen huang", NOW);

  it("says what became of the newest request for the subject, in words", () => {
    expect(status({ status: "pending" })).toEqual({ text: "Waiting for the worker, asked 3 minutes ago.", tone: "wait" });
    expect(status({ status: "running" })).toEqual({ text: "The worker is writing the ideas.", tone: "wait" });
    expect(status({ status: "done", proposalIds: [1, 2, 3], detail: "3 ideas" })).toEqual({ text: "3 ideas filed, asked 3 minutes ago.", tone: "ok" });
    expect(status({ status: "refused", detail: "no longer a Meta" })).toEqual({ text: "Refused: no longer a Meta.", tone: "bad" });
    expect(status({ status: "failed", detail: "the run failed" })).toEqual({ text: "Failed: the run failed.", tone: "bad" });
    expect(status({ status: "capped", detail: "daily cap of 8 meme-ideas runs reached (8 runs, $0.4000 in 24 h)" })?.text).toBe("Not run, a cap was reached: daily cap of 8 meme-ideas runs reached (8 runs, $0.4000 in 24 h).");
    expect(status({ status: "pending", urlDropped: true })?.text).toContain("The link was dropped: it was not a plain http or https address.");
  });

  it("is null for a subject with no request, no list, a key that is missing or a status it does not know", () => {
    expect(angleStatusFor([req()], "other", NOW)).toBeNull();
    expect(angleStatusFor(null, "jensen huang", NOW)).toBeNull();
    expect(angleStatusFor([req()], undefined, NOW)).toBeNull();
    expect(status({ status: "weird" })).toBeNull();
  });

  it("cuts a long reason to one line and never carries markup into a link", () => {
    const text = status({ status: "refused", detail: `<img src=x>\n${"R".repeat(5000)}` })!.text;
    expect(text.length).toBeLessThan(260);
    expect(text).not.toContain("\n");
  });

  it("the counter counts characters, and the button is on for 1 to 600 characters that are not blanks", () => {
    expect(angleCounter("héllo 👍")).toBe("7 / 600");
    expect(angleCanSubmit("")).toBe(false);
    expect(angleCanSubmit("  \n ")).toBe(false);
    expect(angleCanSubmit("x")).toBe(true);
    expect(angleCanSubmit("x".repeat(600))).toBe(true);
    expect(angleCanSubmit("x".repeat(601))).toBe(false);
  });

  it("submitAngle posts exactly { metaKey, angle } and reports the link note; a failure gives the server's reason as one line, whatever shape the error has", async () => {
    const sent: unknown[] = [];
    const ok = await submitAngle(async (b) => (sent.push(b), { id: 1, status: "pending", sourceUrl: null, urlDropped: false }), "gta 6", "an angle");
    expect(sent).toEqual([{ metaKey: "gta 6", angle: "an angle" }]);
    expect(ok).toEqual({ ok: true, note: "Sent. The worker will pick it up." });
    expect(await submitAngle(async () => ({ id: 1, status: "pending", sourceUrl: null, urlDropped: true }), "k", "a")).toMatchObject({ ok: true, note: expect.stringContaining("dropped") });
    expect(await submitAngle(async () => Promise.reject({ data: { statusMessage: "You already asked this angle" } }), "k", "a")).toEqual({ ok: false, message: "You already asked this angle" });
    expect(await submitAngle(async () => Promise.reject({ statusMessage: "One request is waiting" }), "k", "a")).toEqual({ ok: false, message: "One request is waiting" });
    expect(await submitAngle(async () => Promise.reject(new Error("boom")), "k", "a")).toEqual({ ok: false, message: "The request failed. Try again." });
    expect(failureReason({ data: { statusMessage: `x\n${"y".repeat(1000)}` } }).length).toBeLessThanOrEqual(201);
  });
});
