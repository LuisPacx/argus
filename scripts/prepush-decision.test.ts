import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { decidePush, isDocsPath, parseRefLines } from "./prepush-decision.mjs";

const ZERO = "0".repeat(40);
const refLine = (local: string, remote: string, ref = "refs/heads/main") => `${ref} ${local} ${ref} ${remote}\n`;

// Fake git: `files` maps "from..to" to the changed files; `base` is the merge-base with origin/main (null = no origin/main).
const fakeGit = (files: Record<string, string[]>, base: string | null = "base") => ({
  mergeBase: () => base,
  changedFiles: (from: string, to: string) => {
    const hit = files[`${from}..${to}`];
    if (!hit) throw new Error("bad object");
    return hit;
  },
});

describe("isDocsPath", () => {
  it("accepts .scratch/** and *.md at any depth", () => {
    for (const p of [".scratch/cos.md", ".scratch/a/b/shot.png", "README.md", "docs/adr/0001-x.md", "packages/core/NOTES.md"]) expect(isDocsPath(p)).toBe(true);
  });

  it("rejects code, config, and the .md files tests and the Brain read (.claude/**)", () => {
    for (const p of ["src/a.ts", "package.json", ".githooks/pre-push", ".claude/skills/judge/SKILL.md", ".claude/settings.json", "notes.md.ts", "docs/readme.MD", "scratch/a.md.bak", ".scratch.txt"]) {
      expect(isDocsPath(p)).toBe(false);
    }
  });
});

describe("parseRefLines", () => {
  it("splits the four fields and ignores blank lines", () => {
    expect(parseRefLines("refs/heads/a aaa refs/heads/a bbb\n\n")).toEqual([{ localRef: "refs/heads/a", localSha: "aaa", remoteRef: "refs/heads/a", remoteSha: "bbb" }]);
  });
  it("throws on a malformed line", () => {
    expect(() => parseRefLines("garbage")).toThrow();
  });
});

describe("decidePush", () => {
  it("skips when every changed file is a note, counting the union of files", () => {
    const git = fakeGit({ "r1..l1": [".scratch/cos.md", "README.md"], "r2..l2": ["README.md", "docs/architecture.md"] });
    const out = decidePush(refLine("l1", "r1") + refLine("l2", "r2", "refs/heads/other"), git);
    expect(out.skip).toBe(true);
    expect(out.files.sort()).toEqual([".scratch/cos.md", "README.md", "docs/architecture.md"]);
  });

  it("runs the check when any file of any ref is not a note", () => {
    const git = fakeGit({ "r1..l1": ["README.md"], "r2..l2": ["README.md", "src/a.ts"] });
    expect(decidePush(refLine("l1", "r1") + refLine("l2", "r2", "refs/heads/other"), git).skip).toBe(false);
  });

  it("runs the check for a SKILL.md edit", () => {
    expect(decidePush(refLine("l", "r"), fakeGit({ "r..l": [".claude/skills/spec/SKILL.md"] })).skip).toBe(false);
  });

  it("diffs a new remote ref against the merge-base with origin/main", () => {
    expect(decidePush(refLine("l", ZERO), fakeGit({ "base..l": [".scratch/x.md"] })).skip).toBe(true);
    expect(decidePush(refLine("l", ZERO), fakeGit({ "base..l": ["a.ts"] })).skip).toBe(false);
  });

  it("runs the check for a new ref when there is no origin/main", () => {
    expect(decidePush(refLine("l", ZERO), fakeGit({}, null)).skip).toBe(false);
  });

  it("treats a deleted ref as nothing to check, but not when other refs need checking", () => {
    expect(decidePush(refLine(ZERO, "r"), fakeGit({})).skip).toBe(true);
    const git = fakeGit({ "r2..l2": ["a.ts"] });
    expect(decidePush(refLine(ZERO, "r") + refLine("l2", "r2", "refs/heads/b"), git).skip).toBe(false);
  });

  it("runs the check when a live ref changes no files", () => {
    expect(decidePush(refLine("l", "r"), fakeGit({ "r..l": [] })).skip).toBe(false);
  });

  it("runs the check on any git error, empty input, or malformed input", () => {
    expect(decidePush(refLine("l", "unknown-to-git"), fakeGit({})).skip).toBe(false);
    expect(decidePush("", fakeGit({})).skip).toBe(false);
    expect(decidePush("nonsense", fakeGit({})).skip).toBe(false);
  });
});
