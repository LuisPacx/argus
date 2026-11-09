// Pure X page classification and the stop-on-signal loop, free of any browser so they can be
// tested offline. Used by packages/core/scripts/x-capture-spike.mjs.

// STOP signals end the run for the day without retry; the others are recorded and the run goes on.
export const STOP = new Set(["login_wall", "challenge", "locked", "own_suspended", "rate_limited"]);

// facts: { url, text, loggedIn, hasLoginButton, hasChallengeWidget }
export function classify({ url, text, loggedIn, hasLoginButton = false, hasChallengeWidget = false }) {
  const signals = [];
  if (/\/account\/access|\/account\/locked/.test(url) || /your account has been locked|account is locked/i.test(text)) signals.push("locked");
  if (/\/account\/suspended/.test(url) || /your account (has been|is) suspended/i.test(text)) signals.push("own_suspended");
  if (
    /\/i\/flow\/(?!login)/.test(url) ||
    /verify your identity|confirm your identity|unusual (login )?activity|help us keep your account safe|are you a robot|complete the challenge/i.test(text) ||
    hasChallengeWidget
  ) signals.push("challenge");
  if (
    /\/i\/flow\/login|\/login(\?|$)/.test(url) ||
    (!loggedIn && hasLoginButton) ||
    /sign in to x|log in to x|don.t miss what.s happening/i.test(text)
  ) signals.push("login_wall");
  if (/rate limit exceeded|you are being rate limited/i.test(text)) signals.push("rate_limited");
  if (/this account doesn.t exist/i.test(text)) signals.push("not_found");
  if (/account suspended/i.test(text) && !signals.includes("own_suspended") && /\/[A-Za-z0-9_]+$/.test(url)) signals.push("target_suspended");
  // Logged out but no explicit wall: still a login problem.
  if (!loggedIn && !signals.includes("login_wall") && !signals.includes("not_found")) signals.push("login_wall");
  return signals;
}

// The first STOP signal wins; otherwise a recorded status, else "ok".
export function statusOf(signals) {
  const stop = signals.find((s) => STOP.has(s));
  if (stop) return stop;
  if (signals.includes("not_found")) return "not_found";
  if (signals.includes("target_suspended")) return "suspended";
  return "ok";
}

// Runs `capture(target)` serially. Stops at the first STOP status, without retrying and without
// loading any further target. `capture` returns a record with a `status`; a throw is an "error"
// record (not retried, run continues, since it is not an account signal).
export async function captureAll(targets, capture, { maxLoads = Infinity, pause = async () => {} } = {}) {
  const results = [];
  let loads = 0;
  let stopped = null;
  for (const target of targets) {
    if (loads >= maxLoads) break;
    if (loads > 0) await pause();
    loads++;
    let rec;
    try {
      rec = await capture(target);
    } catch (e) {
      rec = { status: "error", error: String(e.message).split("\n")[0] };
    }
    results.push(rec);
    if (STOP.has(rec.status)) {
      stopped = rec.status;
      break;
    }
  }
  return { results, loads, stopped };
}
