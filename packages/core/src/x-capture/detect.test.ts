import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module, no types
import { captureAll, classify, statusOf } from "./detect.mjs";

// Synthetic page facts only: no real X HTML, no account handle.
interface Facts {
  url: string;
  text: string;
  loggedIn: boolean;
  hasLoginButton?: boolean;
  hasChallengeWidget?: boolean;
}

const NORMAL: Facts = { url: "https://x.com/some_token", text: "Some Token\n@some_token\n12 Following\n4 Followers", loggedIn: true };

const WALLS: Array<[string, string, Facts]> = [
  ["login_wall", "login flow URL", { url: "https://x.com/i/flow/login", text: "", loggedIn: false }],
  ["login_wall", "logged out with sign-in text", { url: "https://x.com/some_token", text: "Sign in to X", loggedIn: false, hasLoginButton: true }],
  ["login_wall", "no logged-in nav and no other cue", { url: "https://x.com/some_token", text: "", loggedIn: false }],
  ["challenge", "challenge text", { url: "https://x.com/some_token", text: "Verify your identity", loggedIn: true }],
  ["challenge", "captcha widget", { url: "https://x.com/some_token", text: "", loggedIn: true, hasChallengeWidget: true }],
  ["challenge", "non-login flow URL", { url: "https://x.com/i/flow/consent", text: "", loggedIn: true }],
  ["locked", "access URL", { url: "https://x.com/account/access", text: "", loggedIn: true }],
  ["locked", "locked text", { url: "https://x.com/home", text: "Your account has been locked", loggedIn: true }],
  ["own_suspended", "suspended URL", { url: "https://x.com/account/suspended", text: "", loggedIn: true }],
  ["own_suspended", "suspended text", { url: "https://x.com/home", text: "Your account is suspended", loggedIn: true }],
  ["rate_limited", "rate limit text", { url: "https://x.com/some_token", text: "Rate limit exceeded", loggedIn: true }],
];

describe("classify and statusOf", () => {
  it("does not flag a normal logged-in page", () => {
    const signals = classify(NORMAL);
    expect(signals).toEqual([]);
    expect(statusOf(signals)).toBe("ok");
  });

  it.each(WALLS)("flags %s from a %s", (status, _label, facts) => {
    expect(statusOf(classify(facts))).toBe(status);
  });

  it("records a missing account and a suspended target without stopping", () => {
    expect(statusOf(classify({ ...NORMAL, text: "This account doesn’t exist" }))).toBe("not_found");
    expect(statusOf(classify({ ...NORMAL, text: "Account suspended" }))).toBe("suspended");
  });
});

describe("captureAll", () => {
  const targets = ["a", "b", "c", "d"].map((key) => ({ key }));

  it.each(WALLS)("stops at %s (%s) with no further loads and no retry", async (status, _label, facts) => {
    const loaded: string[] = [];
    let pauses = 0;
    const out = await captureAll(
      targets,
      async (t: { key: string }) => {
        loaded.push(t.key);
        // The second target hits the wall; the rest are fine.
        return { status: statusOf(classify(t.key === "b" ? facts : NORMAL)) };
      },
      { pause: async () => void pauses++ },
    );
    expect(out.stopped).toBe(status);
    expect(out.loads).toBe(2);
    expect(loaded).toEqual(["a", "b"]);
    expect(pauses).toBe(1);
    expect(out.results.map((r: { status: string }) => r.status)).toEqual(["ok", status]);
  });

  it("runs every target when nothing is flagged, and keeps going past not-found and errors", async () => {
    const out = await captureAll(targets, async (t: { key: string }) => {
      if (t.key === "b") return { status: "not_found" };
      if (t.key === "c") throw new Error("navigation timeout\nstack");
      return { status: "ok" };
    });
    expect(out.stopped).toBeNull();
    expect(out.loads).toBe(4);
    expect(out.results[2]).toEqual({ status: "error", error: "navigation timeout" });
  });

  it("honours the load cap", async () => {
    const out = await captureAll(targets, async () => ({ status: "ok" }), { maxLoads: 2 });
    expect(out.loads).toBe(2);
  });
});
