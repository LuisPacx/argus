import { describe, expect, it } from "vitest";
import { reentrant } from "./reentrant.ts";

describe("reentrant", () => {
  it("skips an overlapping call while the first is pending", async () => {
    let release!: () => void;
    let runs = 0;
    let skips = 0;
    const tick = reentrant(
      async () => {
        runs++;
        await new Promise<void>((r) => (release = r));
      },
      () => skips++,
    );
    const first = tick();
    await tick();
    expect({ runs, skips }).toEqual({ runs: 1, skips: 1 });
    release();
    await first;
  });

  it("runs again after completion, including after a throw", async () => {
    let runs = 0;
    const tick = reentrant(async () => {
      runs++;
      if (runs === 1) throw new Error("boom");
    }, () => {});
    await expect(tick()).rejects.toThrow("boom");
    await tick();
    expect(runs).toBe(2);
  });
});
