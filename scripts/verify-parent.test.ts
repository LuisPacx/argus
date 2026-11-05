import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { selectTestChanges, selectTestFiles, splitByStatus, summarize, testNames } from "./verify-parent.mjs";

describe("verify-parent", () => {
  it("selects only added or modified *.test.ts files", () => {
    const out = ["A\ta/x.test.ts", "M\tb/y.test.ts", "D\tc/z.test.ts", "M\td/src.ts", "A\te/w.test.tsx"].join("\n");
    expect(selectTestFiles(out)).toEqual(["a/x.test.ts", "b/y.test.ts"]);
  });

  it("exits 0 when every file has a failing test, and names parent-passing tests", () => {
    const report = {
      testResults: [
        { name: "/r/a.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "f" }, { status: "passed", fullName: "p" }] },
        { name: "/r/b.test.ts", status: "failed", assertionResults: [] },
      ],
    };
    const { lines, exitCode } = summarize(report, ["a.test.ts", "b.test.ts"], "/r");
    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain("passes on parent (suspicious): p");
  });

  it("only judges tests the commit added or changed; tests already in the parent's file are expected to pass", () => {
    const parentSrc = ['describe("x", () => {', '  it("old one", () => {});', "  test.skip('old two', () => {});", "});"].join("\n");
    expect([...testNames(parentSrc)].sort()).toEqual(["old one", "old two"]);
    const report = {
      testResults: [
        {
          name: "/r/a.test.ts",
          status: "failed",
          assertionResults: [
            { status: "failed", title: "new one", fullName: "x new one" },
            { status: "passed", title: "old one", fullName: "x old one" },
            { status: "passed", title: "new passing", fullName: "x new passing" },
          ],
        },
      ],
    };
    const { lines, exitCode } = summarize(report, ["a.test.ts"], "/r", [], { "a.test.ts": testNames(parentSrc) });
    const text = lines.join("\n");
    expect(exitCode).toBe(0);
    expect(text).toContain("passes on parent (unchanged, expected to pass): x old one");
    expect(text).toContain("passes on parent (suspicious): x new passing");
    expect(text).not.toContain("suspicious): x old one");
  });

  it("no-arg mode: added files are strict, modified files are INFO and never change the exit code", () => {
    const changes = selectTestChanges(["A\tnew.test.ts", "M\told.test.ts", "M\tsrc.ts"].join("\n"));
    const { strict, info } = splitByStatus(changes);
    expect(strict).toEqual(["new.test.ts"]);
    expect(info).toEqual(["old.test.ts"]);
    const passing = (name: string) => ({ name: `/r/${name}`, status: "passed", assertionResults: [{ status: "passed", fullName: "p" }] });
    const failing = { name: "/r/new.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "f" }] };
    const ok = summarize({ testResults: [failing, passing("old.test.ts")] }, strict, "/r", info);
    expect(ok.exitCode).toBe(0);
    expect(ok.lines.join("\n")).toContain("INFO (modified file, not gating)  old.test.ts");
    expect(summarize({ testResults: [passing("new.test.ts"), passing("old.test.ts")] }, strict, "/r", info).exitCode).toBe(1);
  });

  it("exits 1 when a file all-passes or was not run", () => {
    const report = { testResults: [{ name: "/r/a.test.ts", status: "passed", assertionResults: [{ status: "passed", fullName: "p" }] }] };
    expect(summarize(report, ["a.test.ts"], "/r").exitCode).toBe(1);
    expect(summarize(report, ["a.test.ts", "missing.test.ts"], "/r").exitCode).toBe(1);
  });
});
