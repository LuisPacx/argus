// The only X addresses the scanner may load: a search page (`https://x.com/search?q=...&f=top|live`) or one post page
// (`https://x.com/<handle>/status/<id>`). Never a profile page, a home timeline, a compose or any other address. Plain Node, no browser.

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_ID_RE = /^[1-9]\d{14,18}$/;
const MAX_QUERY_CHARS = 600;

// Returns true only for an address of the two allowed shapes: https, host x.com exactly (no port, no credentials, no fragment).
export function isAllowedXUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2_000) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "x.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
  if (url.pathname === "/search") {
    const keys = [...url.searchParams.keys()].sort();
    if (keys.length !== 2 || keys[0] !== "f" || keys[1] !== "q") return false;
    const q = url.searchParams.get("q") ?? "";
    const f = url.searchParams.get("f");
    return q.trim() !== "" && q.length <= MAX_QUERY_CHARS && (f === "top" || f === "live");
  }
  const parts = url.pathname.split("/"); // "", handle, "status", id
  return url.search === "" && parts.length === 4 && parts[0] === "" && HANDLE_RE.test(parts[1] ?? "") && parts[2] === "status" && STATUS_ID_RE.test(parts[3] ?? "");
}
