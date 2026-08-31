import { describe, expect, it } from "vitest";
import { cellsBounds, ellipseContains, isShapeMode, shapeBox, shapeCells } from "../src/core/fillShape.ts";

describe("なぞった範囲の枠", () => {
  it("どちらから引いても同じ枠になる", () => {
    const a = shapeBox(10, 20, 110, 220, 1000, 1000);
    const b = shapeBox(110, 220, 10, 20, 1000, 1000);
    expect(a).toEqual(b);
    expect(a).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it("押しただけ(ドラッグ 0px)でも必ず見える大きさが出る", () => {
    const box = shapeBox(500, 500, 500, 500, 1000, 1000);
    expect(box.width).toBeGreaterThanOrEqual(8);
    expect(box.height).toBeGreaterThanOrEqual(8);
    // 指を置いた場所が枠の真ん中に来る。
    expect(box.x + box.width / 2).toBeCloseTo(500, 0);
    expect(box.y + box.height / 2).toBeCloseTo(500, 0);
  });

  it("紙からはみ出さない", () => {
    const box = shapeBox(-50, -50, 2000, 3000, 100, 200);
    expect(box).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });
});

describe("まるの内側判定", () => {
  const box = { x: 0, y: 0, width: 100, height: 50 };

  it("中心は内側", () => {
    expect(ellipseContains(box, 50, 25)).toBe(true);
  });

  it("四隅は外側(枠に内接する楕円なので角は入らない)", () => {
    expect(ellipseContains(box, 0, 0)).toBe(false);
    expect(ellipseContains(box, 100, 50)).toBe(false);
  });

  it("長辺・短辺の端はぎりぎり内側", () => {
    expect(ellipseContains(box, 0, 25)).toBe(true);
    expect(ellipseContains(box, 50, 0)).toBe(true);
  });
});

describe("ビーズのマス", () => {
  const cellW = 10;
  const cellH = 10;

  it("しかくは枠に重なるマスを全部塗る", () => {
    const cells = shapeCells("rect", { x: 0, y: 0, width: 30, height: 20 }, cellW, cellH, 100, 100);
    expect(cells).toHaveLength(6);
  });

  it("まるは角のマスを落とす", () => {
    const rect = shapeCells("rect", { x: 0, y: 0, width: 50, height: 50 }, cellW, cellH, 100, 100);
    const circle = shapeCells("circle", { x: 0, y: 0, width: 50, height: 50 }, cellW, cellH, 100, 100);
    expect(circle.length).toBeLessThan(rect.length);
    expect(circle).not.toContainEqual({ col: 0, row: 0 });
    expect(circle).toContainEqual({ col: 2, row: 2 });
  });

  it("1 マスぶんしか無いときは、まるでも空振りしない", () => {
    // 押しただけのとき、中心判定で 0 個になるとビーズが 1 個も置けない。
    const cells = shapeCells("circle", { x: 2, y: 2, width: 4, height: 4 }, cellW, cellH, 100, 100);
    expect(cells).toEqual([{ col: 0, row: 0 }]);
  });

  it("紙の外のマスは選ばれない", () => {
    const cells = shapeCells("rect", { x: 0, y: 0, width: 1000, height: 1000 }, cellW, cellH, 3, 2);
    expect(cells).toHaveLength(6);
  });

  it("塗ったマスを包む矩形が返る", () => {
    const bounds = cellsBounds([{ col: 1, row: 2 }, { col: 3, row: 2 }], cellW, cellH);
    expect(bounds).toEqual({ x: 10, y: 20, width: 30, height: 10 });
  });

  it("1 マスも無ければ矩形は無い", () => {
    expect(cellsBounds([], cellW, cellH)).toBeNull();
  });
});

describe("塗り方の区別", () => {
  it("かこみだけが色の境界を見る側", () => {
    expect(isShapeMode("area")).toBe(false);
    expect(isShapeMode("rect")).toBe(true);
    expect(isShapeMode("circle")).toBe(true);
  });
});
