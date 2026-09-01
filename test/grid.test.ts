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

  it("縦長キャンバスでは cols/rows が入れ替わり、1 マスは正方形のまま", () => {
    // 横長(1748x1181)を 90 度回した縦長寸法(1181x1748)。UI はまだ無いが
    // 寸法だけ縦長にして cellsFor() を確かめる(残件1のリファクタ対象)。
    const portraitWidth = CANVAS_HEIGHT;
    const portraitHeight = CANVAS_WIDTH;
    const landscapeBeads = cellsFor("beads", CANVAS_WIDTH, CANVAS_HEIGHT);
    const portraitBeads = cellsFor("beads", portraitWidth, portraitHeight);
    // 横長では cols(長辺方向)=58, rows(短辺方向)=39 だったのが、縦長では入れ替わる。
    expect(portraitBeads?.cols).toBe(landscapeBeads?.rows);
    expect(portraitBeads?.rows).toBe(landscapeBeads?.cols);
    // 入れ替えないと縦横比の違うマスになってしまう。1 マスの縦横がほぼ一致すること
    // (この作品寸法では厳密な整数割り切れではないので近似で見る)。
    expect(portraitBeads?.cellWidth).toBeCloseTo(portraitBeads?.cellHeight ?? 0, 0);

    const landscapeDot = cellsFor("dot", CANVAS_WIDTH, CANVAS_HEIGHT);
    const portraitDot = cellsFor("dot", portraitWidth, portraitHeight);
    expect(portraitDot?.cols).toBe(landscapeDot?.rows);
    expect(portraitDot?.rows).toBe(landscapeDot?.cols);
    expect(portraitDot?.cellWidth).toBeCloseTo(portraitDot?.cellHeight ?? 0, 0);
  });
});
