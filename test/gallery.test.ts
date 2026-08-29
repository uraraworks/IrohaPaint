import { describe, expect, it } from "vitest";
import { formatDate } from "../src/ui/gallery.ts";

describe("formatDate", () => {
  const now = new Date(2026, 7, 29).getTime(); // 2026-08-29

  it("同じ年なら年を出さない", () => {
    expect(formatDate(new Date(2026, 7, 3).getTime(), now)).toBe("8がつ3にち");
  });

  it("去年の絵には年を付ける", () => {
    expect(formatDate(new Date(2025, 11, 24).getTime(), now)).toBe("2025ねん12がつ24にち");
  });
});
