import { describe, expect, it } from "vitest";
import { formatDate, formatTime } from "../src/ui/gallery.ts";
import { plainText } from "../src/ui/label.ts";

describe("formatDate", () => {
  const now = new Date(2026, 7, 29).getTime(); // 2026-08-29

  it("同じ年なら年を出さない", () => {
    expect(plainText(formatDate(new Date(2026, 7, 3).getTime(), now))).toBe("8月3日");
  });

  it("去年の絵には年を付ける", () => {
    expect(plainText(formatDate(new Date(2025, 11, 24).getTime(), now))).toBe("2025年12月24日");
  });

  it("漢字にはふりがなが付く(L2 表記)", () => {
    const parts = formatDate(new Date(2026, 7, 3).getTime(), now);
    expect(parts.filter((part) => part.ruby !== undefined).map((part) => part.ruby)).toEqual([
      "がつ",
      "にち",
    ]);
  });
});

describe("formatTime", () => {
  it("時刻は分を 2 桁で揃える", () => {
    expect(formatTime(new Date(2026, 7, 29, 9, 5).getTime())).toBe("9:05");
    expect(formatTime(new Date(2026, 7, 29, 23, 49).getTime())).toBe("23:49");
  });
});
