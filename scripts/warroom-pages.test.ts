import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { pageProblem, pageRoutes } from "./warroom-pages.mjs";

const PAGES = path.resolve(import.meta.dirname, "../apps/warroom/app/pages");

describe("warroom pages", () => {
  it("lists every page route, filling dynamic segments by section", () => {
    expect(pageRoutes(PAGES, { narratives: 4, proposals: 7 })).toEqual(["/", "/narratives", "/narratives/4", "/proposals/7", "/rubric"]);
  });

  it("flags a 500 and a 200 carrying a Nuxt error payload, and passes a healthy page", () => {
    expect(pageProblem(500, '{"message":"[nuxt] setInterval should not be used on the server","statusCode":500}')).toBe(
      "status 500 ([nuxt] setInterval should not be used on the server)",
    );
    expect(pageProblem(404, "<html></html>")).toBe("status 404");
    expect(pageProblem(200, '<div id="__nuxt_error"></div>')).toContain("Nuxt error payload");
    expect(pageProblem(200, "<html><body><div id=\"__nuxt\">ok</div></body></html>")).toBeNull();
  });

  // Regression: pages set up on the server too, so a timer started at setup top level (column 0 in these files) runs there and
  // Nuxt answers 500 "setInterval should not be used on the server". Timers belong in onMounted.
  it("starts no timer at setup top level in any page", () => {
    const files = fs.readdirSync(PAGES, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".vue"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const offenders = fs
        .readFileSync(path.join(PAGES, file), "utf8")
        .split("\n")
        .filter((line) => /^\S.*\b(setInterval|setTimeout)\(/.test(line));
      expect(offenders, file).toEqual([]);
    }
  });
});
