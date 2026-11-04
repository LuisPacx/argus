export class InvalidEvidenceLinkError extends Error {
  constructor() {
    super("Evidence links must be absolute http or https URLs");
    this.name = "InvalidEvidenceLinkError";
  }
}

/**
 * Trims each link, drops blank entries, requires an absolute http(s) URL and
 * removes duplicates (first occurrence wins, order kept).
 * Throws InvalidEvidenceLinkError on anything else.
 */
export function normalizeEvidenceLinks(links: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of links) {
    if (typeof raw !== "string") throw new InvalidEvidenceLinkError();
    const link = raw.trim();
    if (link === "") continue;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new InvalidEvidenceLinkError();
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidEvidenceLinkError();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push(link);
  }
  return out;
}
