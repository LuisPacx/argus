import { describe, expect, it } from "vitest";
import { META_WINDOWS } from "./config.ts";
import { applyGrouping, buildGroupItems, type GroupItem, type GroupSubject, type ThemeInput } from "./grouping.ts";
import type { PreviousMetas } from "./leaders.ts";
import { previousThemeKeys, stabiliseSubjects } from "./stabilise.ts";
import type { CurrentMeta } from "./store.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const STATE_MAX = 120;

const theme = (key: string, tokens: number, creators: number): ThemeInput => ({ key, label: key, tokens, creators, names: [key] });
const counts = Object.fromEntries(META_WINDOWS.map((w) => [w, { tokens: 1, creators: 1, migrations: 0, migrationsAfter60s: 0 }])) as CurrentMeta["counts"];

/** A stored previous subject: `key` plus the member theme keys the grouping step merged into it. */
const prevMeta = (key: string, members: string[], over: Partial<CurrentMeta> = {}): CurrentMeta => ({
  key,
  label: `${key} label`,
  namedBy: "ai",
  themes: members.map((k) => ({ key: k, label: k, tokens: 1, creators: 1 })),
  leader: { mint: "m".repeat(40), name: "L", symbol: "L", marketCapUsd: 1, source: "trending", stale: false, freshAt: NOW.toISOString() },
  holding: false,
  enteredAt: "2026-11-22T09:00:00.000Z",
  counts,
  topTokens: [],
  ...over,
});
const previousAt = (minutesAgo: number, metas: CurrentMeta[], watching: CurrentMeta[] = []): PreviousMetas => ({
  computedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  metas,
  watching,
});

/** The grouping items of a tick (no trending tokens) and a way to write a subject with theme keys instead of ids. */
function world(themes: ThemeInput[]) {
  const items = buildGroupItems([], themes, 0);
  const idOf = (key: string) => (items.find((i): i is Extract<GroupItem, { kind: "theme" }> => i.kind === "theme" && i.key === key) as { id: string }).id;
  const subject = (name: string, ...keys: string[]): GroupSubject => ({ name, items: keys.map(idOf) });
  return { items, subject };
}
/** What the tick would carry: the subject keys and member theme keys after the grouping is applied (the stat is "<key>:<members>"). */
const applied = (items: GroupItem[], subjects: GroupSubject[]) =>
  applyGrouping(
    items,
    subjects,
    (k) => k,
    (members, key) => `${key}:${members.length}`,
  ).subjects;

describe("stabiliseSubjects: a subject keeps its key when the AI renames it", () => {
  it("keeps the previous key, member themes and stat key when the leading theme changes (Christmas became Santa)", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("christmas", 20, 12), theme("xmas", 10, 8)]);
    const prev = previousAt(5, [prevMeta("christmas", ["christmas", "xmas"])]);

    const out = stabiliseSubjects([subject("Santa season", "santa", "christmas", "xmas")], items, prev, NOW, STATE_MAX);
    const [s] = applied(items, out.subjects);

    expect(s?.key).toBe("christmas");
    expect(s?.themeKeys.sort()).toEqual(["christmas", "santa", "xmas"]);
    expect(s?.stat).toBe("christmas:3");
  });

  it("gives a subject with no overlap with any previous subject its own key, as today, and keeps the unmatched previous one", () => {
    const { items, subject } = world([theme("tree", 10, 9), theme("lights", 5, 4), theme("christmas", 1, 1)]);
    const prev = previousAt(5, [prevMeta("easter", ["easter", "bunny"])]);

    const out = stabiliseSubjects([subject("Holiday", "lights", "tree")], items, prev, NOW, STATE_MAX);

    expect(applied(items, out.subjects).map((s) => s.key)).toEqual(["tree"]);
    expect(out.kept.map((m) => m.key)).toEqual(["easter"]);
  });

  it("matches a Watching subject of the previous run as well as a Meta", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("xmas", 10, 8)]);
    const prev = previousAt(5, [], [prevMeta("christmas", ["xmas"])]);

    const out = stabiliseSubjects([subject("Santa", "santa", "xmas")], items, prev, NOW, STATE_MAX);

    expect(applied(items, out.subjects)[0]?.key).toBe("christmas");
    expect(out.kept).toEqual([]);
  });

  it("re-adds a previous member theme the AI left out of every subject, but not one it put in another subject", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("christmas", 20, 12), theme("xmas", 10, 8), theme("tree", 9, 3)]);
    const prev = previousAt(5, [prevMeta("christmas", ["christmas", "xmas", "tree"])]);

    const out = stabiliseSubjects([subject("Santa", "santa", "christmas"), subject("Trees", "tree")], items, prev, NOW, STATE_MAX);
    const subjects = applied(items, out.subjects);

    expect(subjects.map((s) => [s.key, s.themeKeys.sort()])).toEqual([
      ["christmas", ["christmas", "santa", "xmas"]],
      ["tree", ["tree"]],
    ]);
  });
});

describe("stabiliseSubjects: the previous run's subjects live 120 minutes", () => {
  const prevAt = (minutesAgo: number) => previousAt(minutesAgo, [prevMeta("easter", ["easter", "bunny"]), prevMeta("christmas", ["christmas"])]);
  const { items, subject } = world([theme("santa", 40, 30), theme("christmas", 20, 12)]);

  it("keeps a previous subject with no matching member at 119 minutes and drops it at 121", () => {
    const answer = [subject("Santa", "santa", "christmas")];

    expect(stabiliseSubjects(answer, items, prevAt(119), NOW, STATE_MAX).kept.map((m) => m.key)).toEqual(["easter"]);
    expect(stabiliseSubjects(answer, items, prevAt(121), NOW, STATE_MAX).kept).toEqual([]);
  });

  it("inherits a key at 119 minutes and not at 121", () => {
    const answer = [subject("Santa", "santa", "christmas")];

    expect(applied(items, stabiliseSubjects(answer, items, previousAt(119, [prevMeta("noel", ["christmas"])]), NOW, STATE_MAX).subjects)[0]?.key).toBe("noel");
    expect(applied(items, stabiliseSubjects(answer, items, previousAt(121, [prevMeta("noel", ["christmas"])]), NOW, STATE_MAX).subjects)[0]?.key).toBe("santa");
  });
});

describe("stabiliseSubjects: two new subjects over one previous subject", () => {
  it("gives the key to the larger overlap and a fresh key to the other, never the same key twice", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("xmas", 10, 8), theme("christmas", 5, 2)]);
    const prev = previousAt(5, [prevMeta("christmas", ["christmas", "xmas", "santa"])]);

    const out = stabiliseSubjects([subject("Trees", "christmas"), subject("Santa", "santa", "xmas")], items, prev, NOW, STATE_MAX);
    const keys = applied(items, out.subjects).map((s) => [s.name, s.key]);

    expect(keys).toEqual([
      ["Trees", "christmas-2"],
      ["Santa", "christmas"],
    ]);
  });

  it("decides equal overlaps by the smaller key, whatever the order of the answer", () => {
    const { items, subject } = world([theme("alpha", 10, 9), theme("beta", 10, 5)]);
    const prev = previousAt(5, [prevMeta("both", ["alpha", "beta"])]);
    const a = subject("A", "alpha");
    const b = subject("B", "beta");

    for (const answer of [[a, b], [b, a]]) {
      const keys = Object.fromEntries(applied(items, stabiliseSubjects(answer, items, prev, NOW, STATE_MAX).subjects).map((s) => [s.name, s.key]));
      expect(keys).toEqual({ A: "both", B: "beta" });
    }
  });

  it("decides equal overlaps over two previous subjects by the smaller previous key", () => {
    const { items, subject } = world([theme("alpha", 10, 9), theme("beta", 10, 5)]);
    const prevs = [prevMeta("zed", ["alpha", "beta"]), prevMeta("amy", ["alpha", "beta"])];

    for (const metas of [prevs, [...prevs].reverse()]) {
      const out = stabiliseSubjects([subject("AB", "alpha", "beta")], items, previousAt(5, metas), NOW, STATE_MAX);
      expect(applied(items, out.subjects)[0]?.key).toBe("amy");
      expect(out.kept.map((m) => m.key)).toEqual(["zed"]);
    }
  });
});

describe("previous themes reach the AI even below the 30-theme cut", () => {
  /** 35 themes t01..t35, t01 strongest; the tail (t31..t35) is below the cut. */
  const many = Array.from({ length: 35 }, (_, i) => theme(`t${String(i + 1).padStart(2, "0")}`, 100 - i, 100 - i));
  const themeKeys = (items: GroupItem[]) => items.flatMap((i) => (i.kind === "theme" ? [i.key] : []));

  it("cuts at 30 as today when nothing is kept", () => {
    expect(themeKeys(buildGroupItems([], many, 0))).toEqual(many.slice(0, 30).map((t) => t.key));
    expect(themeKeys(buildGroupItems([], many, 0, new Set()))).toEqual(many.slice(0, 30).map((t) => t.key));
  });

  it("adds a kept theme below the cut and keeps every other theme's cut and order", () => {
    const keys = themeKeys(buildGroupItems([], many, 0, new Set(["t34", "t02"])));

    expect(keys).toEqual([...many.slice(0, 30).map((t) => t.key), "t34"]);
  });

  it("previousThemeKeys lists the members of Meta and Watching subjects inside the state window only", () => {
    const metas = [prevMeta("christmas", ["christmas", "xmas"])];
    const watching = [prevMeta("easter", ["bunny"])];

    expect([...previousThemeKeys(previousAt(119, metas, watching), NOW, STATE_MAX)].sort()).toEqual(["bunny", "christmas", "easter", "xmas"]);
    expect(previousThemeKeys(previousAt(121, metas, watching), NOW, STATE_MAX).size).toBe(0);
    expect(previousThemeKeys(undefined, NOW, STATE_MAX).size).toBe(0);
  });
});

describe("stabiliseSubjects: no previous run", () => {
  it("changes nothing and keeps nothing for an undefined, an empty or an expired previous run", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("christmas", 20, 12)]);
    const answer = [subject("Santa", "santa", "christmas")];

    for (const previous of [undefined, previousAt(5, []), previousAt(500, [prevMeta("christmas", ["christmas"])])]) {
      expect(stabiliseSubjects(answer, items, previous, NOW, STATE_MAX)).toEqual({ subjects: answer, kept: [] });
    }
  });

  it("does not change the answer it was given", () => {
    const { items, subject } = world([theme("santa", 40, 30), theme("christmas", 20, 12)]);
    const answer = [subject("Santa", "santa", "christmas")];

    stabiliseSubjects(answer, items, previousAt(5, [prevMeta("noel", ["christmas"])]), NOW, STATE_MAX);

    expect(answer).toEqual([{ name: "Santa", items: ["H1", "H2"] }]);
  });
});
