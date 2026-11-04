import { describe, expect, it } from "vitest";
import { InvalidEvidenceLinkError, normalizeEvidenceLinks } from "./evidence-links.ts";

describe("normalizeEvidenceLinks", () => {
  it("accepts http and https, trims and skips blanks", () => {
    expect(normalizeEvidenceLinks([" http://a.com/x ", "", "https://b.com"])).toEqual(["http://a.com/x", "https://b.com/"]);
  });

  it("stores the parsed URL", () => {
    expect(normalizeEvidenceLinks(["http:example.com"])).toEqual(["http://example.com/"]);
    expect(normalizeEvidenceLinks(["http://a.com/x\ny\tz"])).toEqual(["http://a.com/xyz"]);
  });

  it("removes duplicates and keeps order", () => {
    expect(normalizeEvidenceLinks(["https://b.com", "https://a.com", "https://b.com", "https://a.com"])).toEqual([
      "https://b.com/",
      "https://a.com/",
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "/relative/path",
    "//example.com/x",
    "example.com",
    "ftp://example.com",
    "not a url",
    "https://",
    "http://u:p@a.com",
    "http://u@a.com",
  ])("rejects %s", (link) => {
    expect(() => normalizeEvidenceLinks(["https://ok.com", link])).toThrow(InvalidEvidenceLinkError);
  });

  it("rejects non-string entries", () => {
    expect(() => normalizeEvidenceLinks([42])).toThrow(InvalidEvidenceLinkError);
  });
});
