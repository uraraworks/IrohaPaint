import { describe, expect, it } from "vitest";
import { cellsFor, GRID_MODE_ORDER, GRID_MODES, isGridMode, snapsToCells } from "../src/core/grid.ts";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../src/core/model.ts";

describe("下敷きの種類", () => {
  it("写真は下敷きの種類として認識される", () => {
    expect(isGridMode("photo")).toBe(true);
  });

  it("写真は選択肢の並びに含まれ、マスに吸着しない", () => {
    expect(GRID_MODE_ORDER).toContain("photo");
    expect(GRID_MODES.photo.cellKind).toBeNull();
    expect(cellsFor("photo", CANVAS_WIDTH, CANVAS_HEIGHT)).toBeNull();
  });

  it("ドット絵はマスに吸着し、ビーズより細かい四角のマスになる", () => {
    expect(GRID_MODE_ORDER).toContain("dot");
    expect(snapsToCells("dot")).toBe(true);
    const dot = cellsFor("dot", CANVAS_WIDTH, CANVAS_HEIGHT);
    const beads = cellsFor("beads", CANVAS_WIDTH, CANVAS_HEIGHT);
    // 四角のベタ塗り(穴あきの円はビーズだけ)。
    expect(dot?.round).toBe(false);
    expect(beads?.round).toBe(true);
    // ビーズのちょうど倍の細かさ。
    expect(dot?.cols).toBe((beads?.cols ?? 0) * 2);
    expect(dot?.rows).toBe((beads?.rows ?? 0) * 2);
  });

  it("方眼は目安なのでマスに吸着しない", () => {
    expect(snapsToCells("grid")).toBe(false);
    expect(snapsToCells("off")).toBe(false);
  });
});
