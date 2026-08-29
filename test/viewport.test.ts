import { describe, expect, it } from "vitest";
import { clampView, IDENTITY, MAX_SCALE, panBy, zoomAt } from "../src/core/viewport.ts";

const layout = { left: 100, top: 50, width: 800, height: 540 };

describe("zoomAt", () => {
  it("ピンチの中心にある点は動かない", () => {
    const anchorX = 300;
    const anchorY = 200;
    const view = zoomAt(IDENTITY, layout, anchorX, anchorY, 2);
    // 変換後の同じ局所座標が同じ画面位置に来るか
    const localX = anchorX - layout.left;
    expect(layout.left + view.tx + view.scale * localX).toBeCloseTo(anchorX, 5);
  });

  it("上限を超えて拡大しない(超過分で位置がずれない)", () => {
    let view = IDENTITY;
    for (let i = 0; i < 20; i += 1) view = zoomAt(view, layout, 300, 200, 2);
    expect(view.scale).toBe(MAX_SCALE);
    const localX = 300 - layout.left;
    expect(layout.left + view.tx + view.scale * localX).toBeCloseTo(300, 5);
  });
});

describe("clampView", () => {
  it("等倍まで縮めたら元の位置へ吸着する(紙を見失わせない)", () => {
    const view = clampView({ scale: 1, tx: -400, ty: 300 }, layout, 1000, 700);
    expect(view).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("拡大中に紙を画面外へ飛ばせない", () => {
    const view = clampView(panBy({ scale: 3, tx: 0, ty: 0 }, -99999, -99999), layout, 1000, 700);
    // 紙の右端は画面中央より左には来ない
    expect(layout.left + view.tx + layout.width * 3).toBeGreaterThanOrEqual(500 - 0.001);
  });
});
