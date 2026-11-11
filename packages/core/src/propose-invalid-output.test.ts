import { describe, expect, it } from "vitest";
import { parseProposeOutput } from "./propose.ts";

// Fixtures for ticket 21. They come from real refused propose answers in the acceptance run, but the full outputs were never stored:
// worker.log keeps only the first 200 characters of each. Each fixture here is that logged prefix (name, ticker and the start of the tech
// line, verbatim) completed by hand with a short tail and an evidence array of the size that matches the logged refusal. Run 130 (a name
// retry) logged no prefix at all, so its fixture is a stand-in with the same refusal. The evidence counts (0, 1, 2, 6) are one
// plausible way to miss the 3 to 5 rule; the log cannot say which each run did.

const complete = (prefix: string, tail: string, evidence: unknown): string => `${prefix}${tail}", "whyNow": "It is timely", "interaction": "Visitors pick one", "reason": "It fits the Signals", "description": "A short pitch.", "evidence": ${JSON.stringify(evidence)}}`;
const links = (n: number) => Array.from({ length: n }, (_, i) => `https://news.example/story-${i + 1}`);

const EVIDENCE_PROBLEM = "`evidence` must be an array of 3 to 5 links";

const run103 = '{"name": "Pocket Relay", "ticker": "PRELAY", "tech": "A Cloudflare Workers page that explains and checks self-hosted relay setups: paste a public relay URL, see a status and latency check, and get cop';
const run130 = '{"name": "Relay Stand-in", "ticker": "RSTAND", "tech": "A Cloudflare Workers page that checks a public relay URL';
const run142 = '{"name": "Looseleaf Doodle Kit", "ticker": "DOODLE", "tech": "A Cloudflare Workers page that previews hand-drawn UI components live, with a theme tweaker (wobble, ink color, paper) and copyable shadcn';
const run306 = '{"name": "Decision Day Scenarios", "ticker": "DDAY", "tech": "A Cloudflare Workers page where fans pick Decision Day results and see a live-updating playoff bracket and hosting scenarios, built from p';
const run321 = '{"name": "Deal Lens", "ticker": "DEALENS", "tech": "A Worker page that shows a user-editable checklist of camera and tech gear, with seasonal sale reminders and links to public retailer deal pages, al';
const run334 = '{"name": "Toolbox Tally", "ticker": "TLBX", "tech": "A Cloudflare Workers page that lists public industrial-supply deal pages and shows each one\'s stated discount and last-updated date, with a simple ';

describe("real failing propose outputs (prefix from worker.log, completed): refused with the exact problem", () => {
  const cases: Array<[string, string, string, unknown]> = [
    ["run 103, no evidence links", run103, "y-ready notes", []],
    ["run 130, one link", run130, ".", links(1)],
    ["run 142, two links", run142, " code", links(2)],
    ["run 306, six links", run306, "ublic data", links(6)],
    ["run 321, no evidence links", run321, "so a cheap deal", []],
    ["run 321, one link", run321, "so a cheap deal", links(1)],
    ["run 103, two links", run103, "y-ready notes", links(2)],
    ["run 142, six links", run142, " code", links(6)],
  ];
  for (const [label, prefix, tail, evidence] of cases) {
    it(`${label}`, () => {
      expect(parseProposeOutput(complete(prefix, tail, evidence))).toEqual({ ok: false, problem: EVIDENCE_PROBLEM });
    });
  }

  it("the same outputs with 3 to 5 links are accepted, so the evidence count is the only fault", () => {
    for (const n of [3, 5]) expect(parseProposeOutput(complete(run103, "y-ready notes", links(n))).ok).toBe(true);
  });

  it("run 334, tech over 200 characters", () => {
    const tail = "table of rows that the visitor can sort, filter by shop and export as a shareable link for later, plus a note on how fresh each row is";
    const text = complete(run334, tail, links(3));
    expect((JSON.parse(text) as { tech: string }).tech.length).toBeGreaterThan(200);
    expect(parseProposeOutput(text)).toEqual({ ok: false, problem: "`tech` is over 200 characters" });
  });
});
