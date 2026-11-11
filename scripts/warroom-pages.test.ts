import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { activityProblem, pageProblem, pageRoutes, serverLogProblem } from "./warroom-pages.mjs";

import { DEFAULT_PROPOSAL_SORT, proposalApiSort, proposalCapText, proposalUrlSort } from "../apps/warroom/app/utils/proposal-sort";

const PAGES = path.resolve(import.meta.dirname, "../apps/warroom/app/pages");

describe("warroom pages", () => {
  it("lists every page route, filling dynamic segments by section", () => {
    expect(pageRoutes(PAGES, { narratives: 4, proposals: 7 })).toEqual(["/", "/activity", "/meta", "/narratives", "/narratives/4", "/proposals/7", "/rubric", "/study"]);
  });

  it("requires the four /activity section headings in the SSR HTML and flags nitro errors in the server output", () => {
    const html = (...h: string[]) => h.map((x) => `<h3 class="t">${x}</h3>`).join("");
    expect(activityProblem(html("Sources", "Narratives", "Brain runs", "Usage today"))).toBeNull();
    expect(activityProblem(html("Sources", "Narratives"))).toBe("SSR HTML lacks the heading(s) Brain runs, Usage today");
    expect(serverLogProblem("ready\n[nitro] 500 boom\n")).toContain("[nitro]");
    expect(serverLogProblem("ready\nListening on :3150\n")).toBeNull();
  });

  it("flags a 500 and a 200 carrying a Nuxt error payload, and passes a healthy page", () => {
    expect(pageProblem(500, '{"message":"[nuxt] setInterval should not be used on the server","statusCode":500}')).toBe(
      "status 500 ([nuxt] setInterval should not be used on the server)",
    );
    expect(pageProblem(404, "<html></html>")).toBe("status 404");
    expect(pageProblem(200, '<div id="__nuxt_error"></div>')).toContain("Nuxt error payload");
    expect(pageProblem(200, "<html><body><div id=\"__nuxt\">ok</div></body></html>")).toBeNull();
  });

  it("sorts Proposals newest first by default, always naming the sort to the API (whose own default stays score)", () => {
    expect(DEFAULT_PROPOSAL_SORT).toBe("newest");
    expect(proposalUrlSort("newest")).toBeUndefined();
    expect(proposalUrlSort("score")).toBe("score");
    expect(proposalApiSort("")).toBe("newest");
    expect(proposalApiSort("score")).toBe("score");
    const page = fs.readFileSync(path.join(PAGES, "index.vue"), "utf8");
    expect(page).toContain("DEFAULT_PROPOSAL_SORT");
    expect(page).toContain("apiQuery(current.value)");
    expect(page).toContain('{ value: "score", label: "Score" }');
  });

  it("labels the Proposals cap as a rolling last 24 h count on both pages that show it", () => {
    expect(proposalCapText(12, 30)).toBe("12 of 30 in the last 24 h");
    for (const file of ["index.vue", "activity.vue"]) {
      const src = fs.readFileSync(path.join(PAGES, file), "utf8");
      expect(src, file).toContain("proposalCapText(");
      expect(src, file).not.toMatch(/Proposals today|Proposals a day/);
    }
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
