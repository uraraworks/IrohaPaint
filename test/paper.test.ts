import { describe, expect, it } from "vitest";
import { isPaperKind, PAPER_KIND_ORDER, PAPER_KINDS } from "../src/core/paper.ts";

// createPaperTexture は canvas(OffscreenCanvas / document.createElement)に触れるため、
// DOM の無い node 環境では検証できない。canvas 描画そのものの見た目確認はブラウザで行う。

describe("紙の種類", () => {
  it("plain/straw/canvas を紙の種類として認識し、それ以外は弾く", () => {
    expect(isPaperKind("plain")).toBe(true);
    expect(isPaperKind("straw")).toBe(true);
    expect(isPaperKind("canvas")).toBe(true);
    expect(isPaperKind("origami")).toBe(false);
    expect(isPaperKind(123)).toBe(false);
    expect(isPaperKind(undefined)).toBe(false);
  });

  it("並び順は plain/straw/canvas の 3 種すべてを含み、先頭は plain", () => {
    expect(PAPER_KIND_ORDER).toHaveLength(3);
    expect(PAPER_KIND_ORDER[0]).toBe("plain");
    expect(PAPER_KIND_ORDER).toContain("straw");
    expect(PAPER_KIND_ORDER).toContain("canvas");
  });

  it("各定義が id・label・iconSvg を持つ", () => {
    for (const kind of PAPER_KIND_ORDER) {
      const def = PAPER_KINDS[kind];
      expect(def.id).toBe(kind);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.iconSvg).toContain("<svg");
    }
  });
});
