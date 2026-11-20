import { describe, expect, it } from "vitest";
import { automaticAgents, automaticAgentsLine, researchTickEnabled } from "./index.ts"; // via the barrel: see startup-config.test.ts

describe("ADR 0017 automatic agents", () => {
  it("are all off by default, each with the variable that turns it on", () => {
    const agents = automaticAgents({});
    expect(agents.map((a) => [a.id, a.switch, a.on])).toEqual([
      ["research-tick", "ARGUS_RESEARCH_TICK", false],
      ["meta-meme-ideas", "ARGUS_MEME_IDEAS", false],
      ["moment-scanner", "ARGUS_MOMENTS", false],
    ]);
    const line = automaticAgentsLine(agents);
    expect(line).toContain("Automatic agents off");
    for (const v of ["ARGUS_RESEARCH_TICK=1", "ARGUS_MEME_IDEAS=1", "ARGUS_MOMENTS=1"]) expect(line).toContain(v);
  });

  it("each switch turns on by itself, and only the exact string 1 does", () => {
    expect(automaticAgents({ ARGUS_RESEARCH_TICK: "1" }).map((a) => a.on)).toEqual([true, false, false]);
    expect(automaticAgents({ ARGUS_MEME_IDEAS: "1" }).map((a) => a.on)).toEqual([false, true, false]);
    expect(automaticAgents({ ARGUS_MOMENTS: "1" }).map((a) => a.on)).toEqual([false, false, true]);
    expect(automaticAgentsLine(automaticAgents({ ARGUS_RESEARCH_TICK: "1" }))).not.toContain("Research tick");
    expect(automaticAgentsLine(automaticAgents({ ARGUS_RESEARCH_TICK: "1", ARGUS_MEME_IDEAS: "1", ARGUS_MOMENTS: "1" }))).toContain("all on");
    expect(researchTickEnabled({ ARGUS_RESEARCH_TICK: "0" })).toBe(false);
    expect(researchTickEnabled({ ARGUS_RESEARCH_TICK: "" })).toBe(false);
  });

  it("an unreadable research switch is an error, never a silent default", () => {
    expect(() => researchTickEnabled({ ARGUS_RESEARCH_TICK: "yes" })).toThrow(/ARGUS_RESEARCH_TICK/);
  });
});
