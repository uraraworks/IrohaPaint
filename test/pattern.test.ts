import { describe, expect, it } from "vitest";
import { PATTERN_ORDER, PATTERNS, isPatternId } from "../src/core/pattern.ts";

// patternTile() は canvas を使うので、DOM の無い vitest 環境ではテストしない。

describe("PATTERN_ORDER", () => {
  it("先頭が solid(もようなし)で、全 id を含む", () => {
    expect(PATTERN_ORDER[0]).toBe("solid");
    expect(new Set(PATTERN_ORDER)).toEqual(new Set(Object.keys(PATTERNS)));
  });

  it("全ての定義が label と iconSvg を持つ", () => {
    for (const id of PATTERN_ORDER) {
      const def = PATTERNS[id];
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.iconSvg).toContain("<svg");
    }
  });
});

describe("isPatternId", () => {
  it("有効な id だけ true", () => {
    for (const id of PATTERN_ORDER) expect(isPatternId(id)).toBe(true);
    expect(isPatternId("nope")).toBe(false);
    expect(isPatternId(123)).toBe(false);
  });
});
