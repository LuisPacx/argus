import { describe, expect, it } from "vitest";
import { isStatusId, statusIdTime } from "./status-id.ts";

describe("statusIdTime", () => {
  it("reads the two IDs of the scan notes as their exact times", () => {
    expect(statusIdTime("2123280111864811617")?.toISOString().slice(0, 19)).toBe("2026-11-19T05:00:01"); // 05:00:01.962
    expect(statusIdTime("2123280111864811617")?.getTime()).toBe(Date.parse("2026-11-19T05:00:01.962Z"));
    expect(statusIdTime("2123384751901778317")?.toISOString().slice(0, 19)).toBe("2026-11-19T11:55:50");
  });

  it("decodes the FelpsCrypto clip to 10:17 UTC, the minute the notes give", () => {
    expect(statusIdTime("2123359908179415231")?.toISOString().slice(0, 16)).toBe("2026-11-19T10:17");
  });

  it.each(["", "abc", "12345", "12345678901234", "0123456789012345678", "-2123280111864811617", "2123280111864811617x", "21232801118648116170000", " 2123280111864811617", "2123280111864811617\n", "२१२३२८०१११८६४८११६१७"])("refuses %j", (id) => {
    expect(statusIdTime(id)).toBeNull();
    expect(isStatusId(id)).toBe(false);
  });

  it("refuses a value that is not text", () => {
    expect(statusIdTime(Number("2123280111864811617") as unknown as string)).toBeNull();
    expect(isStatusId(null)).toBe(false);
  });

  it("accepts 15 digits at the short end", () => {
    expect(isStatusId("100000000000000")).toBe(true);
    expect(statusIdTime("100000000000000")).toBeInstanceOf(Date);
  });
});
