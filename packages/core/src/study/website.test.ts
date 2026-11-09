import { describe, expect, it } from "vitest";
import type { Resolver, Transport, TransportResponse } from "./guarded-fetch.ts";
import { analyzeHtml, fetchWebsite, robotsAllows } from "./website.ts";

const PUBLIC = "93.184.216.34";
const reply = (status: number, headers: Record<string, string>, body: string): TransportResponse => ({
  status,
  headers,
  body: (async function* () {
    yield Buffer.from(body);
  })(),
  destroy: () => {},
});
const html = (body: string) => reply(200, { "content-type": "text/html; charset=utf-8" }, body);

function fakeNet(dns: Record<string, string[]>, pages: Record<string, TransportResponse | (() => TransportResponse | Promise<TransportResponse>)>) {
  const requests: string[] = [];
  const resolve: Resolver = async (host) => dns[host] ?? [PUBLIC];
  const transport: Transport = async (req) => {
    requests.push(req.url.href);
    const p = pages[req.url.href];
    if (!p) return reply(404, {}, "");
    return typeof p === "function" ? p() : p;
  };
  return { resolve, transport, requests };
}
const opts = { maxBytes: 100_000, textChars: 20_000, timeoutMs: 1_000, emptyShellMaxVisibleChars: 80 };

const REAL_PAGE = `<!doctype html><html><head><title>  Moon Cat </title></head><body><h1>Moon Cat</h1><p>${"The first cat on the moon, funded by memes. ".repeat(5)}</p><script src="/a.js"></script></body></html>`;
const SHELL = `<!doctype html><html><head><title>Moon</title><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;

describe("analyzeHtml", () => {
  it("extracts the title and the visible text, without markup, scripts or styles", () => {
    const a = analyzeHtml(`<html><head><title> Hi   there </title><style>p{color:red}</style></head><body><p>Hello <b>big</b> world</p><script>alert("x")</script><!-- c --></body></html>`, 20_000, 80);
    expect(a.title).toBe("Hi there");
    expect(a.text).toBe("Hello big world");
  });

  it("caps the text", () => {
    expect(analyzeHtml(`<body><p>${"a".repeat(500)}</p></body>`, 100, 80).text).toHaveLength(100);
  });

  it("flags an empty app shell: a mount point and a script, almost no visible text", () => {
    expect(analyzeHtml(SHELL, 20_000, 80).emptyShell).toBe(true);
    expect(analyzeHtml(`<body><div id="__next"></div><script>self.__next_f=[]</script></body>`, 20_000, 80).emptyShell).toBe(true);
  });

  it("does not flag a page with real text, even with scripts", () => {
    const a = analyzeHtml(REAL_PAGE, 20_000, 80);
    expect(a.emptyShell).toBe(false);
    expect(a.text.length).toBeGreaterThan(80);
  });

  it("does not flag a tiny static page that has no script (it is not an app shell)", () => {
    expect(analyzeHtml("<html><body><p>Coming soon</p></body></html>", 20_000, 80).emptyShell).toBe(false);
  });

  it("strips control characters from the text", () => {
    expect(analyzeHtml(`<body><p>a\u0000b‮c\u0007d</p></body>`, 100, 80).text).toBe("abcd");
  });
});

describe("robotsAllows", () => {
  it("allows everything when there is nothing to disallow", () => {
    expect(robotsAllows("", "/anything")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:", "/anything")).toBe(true);
  });
  it("honours Disallow for * and for our own agent, with the most specific group winning", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/private/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/public")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n\nUser-agent: ArgusStudy\nAllow: /", "/x")).toBe(true);
    expect(robotsAllows("User-agent: *\nAllow: /\n\nUser-agent: argusstudy\nDisallow: /", "/x")).toBe(false);
  });
  it("longest match wins and Allow beats Disallow on a tie; wildcards and $ work", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a/b", "/a/b/c")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /a\nAllow: /a", "/a")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/x/y.pdf")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/x/y.pdf?z")).toBe(true);
  });
  it("ignores comments and unknown lines", () => {
    expect(robotsAllows("# hi\nUser-agent: * # all\nCrawl-delay: 5\nDisallow: /x # no", "/x")).toBe(false);
  });
});

describe("fetchWebsite", () => {
  it("fetches robots.txt then the one page, and returns title, text, hash-ready fields and the shell flag", async () => {
    const net = fakeNet({}, { "https://moon.example/robots.txt": reply(404, {}, ""), "https://moon.example/": html(REAL_PAGE) });
    const r = await fetchWebsite("https://moon.example/", { ...opts, ...net });
    expect(r).toMatchObject({ status: "ok", httpStatus: 200, finalUrl: "https://moon.example/", contentType: "text/html; charset=utf-8", title: "Moon Cat", emptyShell: false, truncated: false });
    expect(r.text).toContain("first cat on the moon");
    expect(r.responseMs).toBeGreaterThanOrEqual(0);
    expect(net.requests).toEqual(["https://moon.example/robots.txt", "https://moon.example/"]);
  });

  it("fetches one URL only: nothing the page links to is requested", async () => {
    const page = `<body><p>${"hello there friend ".repeat(10)}</p><a href="https://moon.example/about">about</a><a href="https://other.example/">x</a><img src="/i.png"><iframe src="/f"></iframe><link rel="stylesheet" href="/s.css"><script src="/a.js"></script></body>`;
    const net = fakeNet({}, { "https://moon.example/x": html(page) });
    await fetchWebsite("https://moon.example/x", { ...opts, ...net });
    expect(net.requests).toEqual(["https://moon.example/robots.txt", "https://moon.example/x"]);
  });

  it("refuses private and loopback addresses, as literals, by name and through a redirect", async () => {
    for (const url of ["http://127.0.0.1/", "http://10.1.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      const net = fakeNet({}, {});
      expect(await fetchWebsite(url, { ...opts, ...net }), url).toMatchObject({ status: "blocked", text: "" });
      expect(net.requests, url).toEqual([]);
    }
    const byName = fakeNet({ "internal.example": ["192.168.1.5"] }, {});
    expect(await fetchWebsite("https://internal.example/", { ...opts, ...byName })).toMatchObject({ status: "blocked" });
    expect(byName.requests).toEqual([]);

    const viaRedirect = fakeNet({}, { "https://moon.example/robots.txt": reply(404, {}, ""), "https://moon.example/": reply(302, { location: "http://169.254.169.254/latest/meta-data/" }, "") });
    expect(await fetchWebsite("https://moon.example/", { ...opts, ...viaRedirect })).toMatchObject({ status: "blocked" });
    expect(viaRedirect.requests).toEqual(["https://moon.example/robots.txt", "https://moon.example/"]);
  });

  it("does not fetch the page when robots.txt disallows it", async () => {
    const net = fakeNet({}, { "https://moon.example/robots.txt": reply(200, { "content-type": "text/plain" }, "User-agent: *\nDisallow: /"), "https://moon.example/": html(REAL_PAGE) });
    const r = await fetchWebsite("https://moon.example/", { ...opts, ...net });
    expect(r).toMatchObject({ status: "robots-disallowed", text: "" });
    expect(net.requests).toEqual(["https://moon.example/robots.txt"]);
  });

  it("checks robots.txt of a redirect target's host too", async () => {
    const net = fakeNet(
      {},
      {
        "https://a.example/robots.txt": reply(404, {}, ""),
        "https://a.example/": reply(301, { location: "https://b.example/landing" }, ""),
        "https://b.example/robots.txt": reply(200, {}, "User-agent: *\nDisallow: /landing"),
        "https://b.example/landing": html(REAL_PAGE),
      },
    );
    expect(await fetchWebsite("https://a.example/", { ...opts, ...net })).toMatchObject({ status: "robots-disallowed" });
    expect(net.requests).not.toContain("https://b.example/landing");
  });

  it("follows the RFC for robots.txt failures: a 4xx means allowed, a 5xx or an unreachable file means not allowed", async () => {
    const forbidden = fakeNet({}, { "https://m.example/robots.txt": reply(403, {}, ""), "https://m.example/": html(REAL_PAGE) });
    expect(await fetchWebsite("https://m.example/", { ...opts, ...forbidden })).toMatchObject({ status: "ok" });
    const broken = fakeNet({}, { "https://m.example/robots.txt": reply(503, {}, ""), "https://m.example/": html(REAL_PAGE) });
    expect(await fetchWebsite("https://m.example/", { ...opts, ...broken })).toMatchObject({ status: "robots-disallowed" });
    expect(broken.requests).toEqual(["https://m.example/robots.txt"]);
  });

  it("stores no text for a non-HTML answer but keeps the content type", async () => {
    for (const type of ["application/pdf", "image/png", "application/json", "text/plain"]) {
      const net = fakeNet({}, { "https://m.example/f": reply(200, { "content-type": type }, "%PDF-1.4 binary") });
      expect(await fetchWebsite("https://m.example/f", { ...opts, ...net }), type).toMatchObject({ status: "non-html", contentType: type, text: "", title: "", emptyShell: null });
    }
  });

  it("cuts a page at the size cap and says so", async () => {
    const big = `<body><p>${"word ".repeat(100_000)}</p></body>`;
    const net = fakeNet({}, { "https://m.example/": html(big) });
    const r = await fetchWebsite("https://m.example/", { ...opts, ...net, maxBytes: 5_000 });
    expect(r).toMatchObject({ status: "ok", truncated: true });
    expect(r.text.length).toBeLessThanOrEqual(5_000);
  });

  it("gives up at the time cap, robots.txt time included", async () => {
    const net = fakeNet({}, { "https://slow.example/robots.txt": () => new Promise<TransportResponse>(() => {}) });
    const started = Date.now();
    const r = await fetchWebsite("https://slow.example/", { ...opts, ...net, timeoutMs: 50 });
    expect(r.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports an HTTP error status without text", async () => {
    const net = fakeNet({}, { "https://m.example/": reply(500, { "content-type": "text/html" }, "<p>boom</p>") });
    expect(await fetchWebsite("https://m.example/", { ...opts, ...net })).toMatchObject({ status: "http-error", httpStatus: 500, text: "" });
  });

  it("flags an app shell found by the fetch", async () => {
    const net = fakeNet({}, { "https://app.example/": html(SHELL) });
    expect(await fetchWebsite("https://app.example/", { ...opts, ...net })).toMatchObject({ status: "ok", emptyShell: true });
  });
});
