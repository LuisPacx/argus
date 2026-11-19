import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Moment scanner never posts, likes, follows, replies or messages: the script and everything it runs in the page may only navigate (goto), scroll
// with the mouse wheel and read. This test greps their source, comments included, and fails on any call that could act on a page.
const CORE = path.join(import.meta.dirname, "..", "..");
const FILES = ["scripts/x-search-scan.mjs", "src/x-capture/posts.mjs", "src/x-capture/session.mjs", "src/x-capture/scan.mjs", "src/x-capture/urls.mjs", "src/x-capture/lock.mjs", "src/x-capture/scrub.mjs"];
const FORBIDDEN = [".click(", ".dblclick(", ".fill(", ".type(", ".press(", ".check(", ".uncheck(", ".tap(", ".hover(", ".dragTo(", ".selectOption(", ".setInputFiles(", ".dispatchEvent(", "dispatchEvent", "keyboard", "mouse.down", "mouse.up", "mouse.click", "window.open", "fetch(", "XMLHttpRequest", "sendBeacon", ".request.", "page.route", "setExtraHTTPHeaders", "addCookies", "storageState", "localStorage", "sessionStorage", "document.cookie"];

const read = (f: string) => readFileSync(path.join(CORE, f), "utf8");

describe("the scanner is read-only", () => {
  it.each(FILES)("%s has no call that clicks, types, submits, opens a window or sends a request", (f) => {
    const src = read(f);
    for (const token of FORBIDDEN) expect(src.includes(token), `${f} contains ${token}`).toBe(false);
  });

  it("goto is called in one place, on the address it was given, and the only mouse call is the wheel", () => {
    const sources = FILES.map(read).join("\n");
    expect(sources.match(/\.goto\(/g)).toHaveLength(1);
    expect(read("src/x-capture/session.mjs")).toContain("page.goto(url,");
    expect(sources.match(/\bmouse\.\w+/g)).toEqual(["mouse.wheel"]);
  });

  it("the child opens no address but through the allowlist: the plan is checked by planProblem before the lock and the browser", () => {
    const script = read("scripts/x-search-scan.mjs");
    expect(script.indexOf("planProblem(plan)")).toBeGreaterThan(-1);
    expect(script.indexOf("planProblem(plan)")).toBeLessThan(script.indexOf("openSession("));
    const scan = read("src/x-capture/scan.mjs");
    expect(scan.indexOf("planProblem(plan, maxLoads)")).toBeLessThan(scan.indexOf("lock()"));
    expect(scan.indexOf("lock()")).toBeLessThan(scan.indexOf("await open()"));
    expect(scan).toContain("isAllowedXUrl(item.url)");
  });

  it("the in-page collector only reads: it has no assignment to the page and no call besides the queries", () => {
    const posts = read("src/x-capture/posts.mjs");
    const body = posts.slice(posts.indexOf("export function collectArticles"), posts.indexOf("const STATUS_LINK_RE"));
    expect(body).not.toMatch(/\.(?:innerHTML|outerHTML|textContent|value|href|src)\s*=[^=]/);
    expect(body).not.toMatch(/\.(?:remove|append|appendChild|insertBefore|setAttribute|submit|focus|blur|scroll\w*)\(/);
  });
});
