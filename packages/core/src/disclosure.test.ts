import { describe, expect, it } from "vitest";
import { DISCLOSURE_SENTENCE, checkDisclosure } from "./disclosure.ts";

const BASE = "https://cat.example.workers.dev";
const footer = `<footer data-argus-disclosure>${DISCLOSURE_SENTENCE}</footer>`;
const html = (body: string, withFooter = true) => `<!doctype html><html><body>${body}${withFooter ? footer : ""}</body></html>`;

/** A fake preview: path -> [status, content-type, body]. Unknown paths are a 404 with the given 404 page. */
function preview(pages: Record<string, [number, string, string]>, notFound: [number, string, string] = [404, "text/html", html("<h1>Not found</h1>")]) {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    const [status, type, body] = pages[url.pathname + url.search] ?? notFound;
    return new Response(body, { status, headers: { "content-type": type } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const check = (fetchFn: typeof fetch, extra: Parameters<typeof checkDisclosure>[2] = {}) =>
  checkDisclosure(BASE, fetchFn, { attempts: 1, delayMs: 0, ...extra });

describe("checkDisclosure", () => {
  it("passes when every same-origin HTML page and the 404 page carry the exact sentence", async () => {
    const { fetchFn, seen } = preview({
      "/": [200, "text/html", html('<a href="/about">about</a> <a href="https://elsewhere.test/x">out</a>')],
      "/about": [200, "text/html; charset=utf-8", html("<p>about</p>")],
    });
    const res = await check(fetchFn);
    expect(res).toEqual({ ok: true, problems: [], pages: 3 });
    expect(seen).toContain("/__argus_not_found__");
    expect(seen.some((p) => p.includes("elsewhere"))).toBe(false);
  });

  it("fails when a linked page lacks the sentence", async () => {
    const { fetchFn } = preview({
      "/": [200, "text/html", html('<a href="/bare">x</a>')],
      "/bare": [200, "text/html", html("<p>no footer</p>", false)],
    });
    const res = await check(fetchFn);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("/bare");
  });

  it("fails when the 404 page lacks the sentence", async () => {
    const { fetchFn } = preview({ "/": [200, "text/html", html("<p>home</p>")] }, [404, "text/html", html("<h1>nope</h1>", false)]);
    const res = await check(fetchFn);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("/__argus_not_found__");
  });

  it("does not trust a reworded sentence, or one hidden in a comment, script or style", async () => {
    for (const bad of [
      "<footer>This project was created by argus. The creator may sell this project.</footer>",
      `<!-- ${DISCLOSURE_SENTENCE} -->`,
      `<script>var s = "${DISCLOSURE_SENTENCE}";</script>`,
      `<style>.x::after{content:"${DISCLOSURE_SENTENCE}"}</style>`,
    ]) {
      const { fetchFn } = preview({ "/": [200, "text/html", `<!doctype html><html><body>${bad}</body></html>`] }, [404, "text/html", html("", true)]);
      expect((await check(fetchFn)).ok, bad).toBe(false);
    }
  });

  it("accepts the sentence split across tags and whitespace", async () => {
    const split = DISCLOSURE_SENTENCE.replace(", an autonomous", ",\n <b>an</b>   autonomous");
    const { fetchFn } = preview({ "/": [200, "text/html", `<!doctype html><html><body><footer>${split}</footer></body></html>`] });
    expect((await check(fetchFn)).ok).toBe(true);
  });

  it("ignores non-HTML responses but checks HTML served without a content type", async () => {
    const { fetchFn } = preview({
      "/": [200, "text/html", html('<a href="/data.json">j</a> <a href="/sneaky">s</a>')],
      "/data.json": [200, "application/json", '{"a":1}'],
      "/sneaky": [200, "application/octet-stream", "<!doctype html><html><body>no footer</body></html>"],
    });
    const res = await check(fetchFn);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("/sneaky");
    expect(res.problems.join("\n")).not.toContain("data.json");
  });

  it("follows a same-origin redirect and ignores a cross-origin one", async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return new Response(html('<a href="/old">old</a> <a href="/away">away</a>'), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/old") return new Response(null, { status: 302, headers: { location: "/new" } });
      if (url.pathname === "/away") return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
      if (url.pathname === "/new") return new Response(html("<p>new</p>", false), { headers: { "content-type": "text/html" } });
      return new Response(html(""), { status: 404, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const res = await check(fetchFn);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("/new");
  });

  it("fails, saying the check is incomplete, when the page cap is reached", async () => {
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">p</a>`).join("");
    const pages: Record<string, [number, string, string]> = { "/": [200, "text/html", html(links)] };
    for (let i = 0; i < 10; i++) pages[`/p${i}`] = [200, "text/html", html("<p>x</p>")];
    const res = await check(preview(pages).fetchFn, { maxPages: 5 });
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toMatch(/incomplete/);
  });

  it("fails when / never responds OK, after retrying", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;
    const res = await checkDisclosure(BASE, fetchFn, { attempts: 3, delayMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toMatch(/did not respond/);
    expect(calls).toBe(3);
  });

  it("retries a preview that is not up yet, then passes", async () => {
    let calls = 0;
    const ok = preview({ "/": [200, "text/html", html("<p>up</p>")] }).fetchFn;
    const fetchFn = (async (input: string | URL | Request) => {
      if (++calls <= 2) throw new TypeError("fetch failed");
      return ok(input);
    }) as typeof fetch;
    expect((await checkDisclosure(BASE, fetchFn, { attempts: 4, delayMs: 0 })).ok).toBe(true);
  });

  it("a page whose fetch throws is a problem, not a crash", async () => {
    const good = preview({ "/": [200, "text/html", html('<a href="/boom">b</a>')] }).fetchFn;
    const fetchFn = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === "/boom") throw new TypeError("socket hang up");
      return good(input);
    }) as typeof fetch;
    const res = await check(fetchFn);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toContain("/boom");
  });
});
