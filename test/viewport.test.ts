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
  // 実際のアプリでは layout(紙) は CSS(flexbox の中央寄せ)によって、常に
  // viewport(画面=.stage) の中央にぴったり収まった状態(scale=1)から出発する。
  // タブレット相当: 紙(800x540)が画面(1000x700)に収まる。
  const tabletViewport = { left: 0, top: 0, width: 1000, height: 700 };
  const tabletLayout = {
    left: (tabletViewport.width - layout.width) / 2,
    top: (tabletViewport.height - layout.height) / 2,
    width: layout.width,
    height: layout.height,
  };

  it("紙が画面に収まる軸は、どんな tx/ty を渡しても中央に固定される(タブレット)", () => {
    const view = clampView({ scale: 1, tx: -400, ty: 300 }, tabletLayout, tabletViewport);
    expect(view.tx).toBeCloseTo(0, 5);
    expect(view.ty).toBeCloseTo(0, 5);
  });

  it("従来どおり、タブレットで倍率1のときは中央のまま(後退していない)", () => {
    // 昔の実装は scale<=1 のとき無条件で tx=0, ty=0 に吸着していた。
    // 一般化した今も、紙が画面に収まっている(=タブレット)ケースでは同じ結果になる。
    const view = clampView({ scale: 1, tx: 123, ty: -45 }, tabletLayout, tabletViewport);
    expect(view).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("紙が画面より大きい軸では、範囲内の tx はそのまま通る", () => {
    // スマホ相当: 紙(800x540 を2倍 = 1600x1080)が画面(390x700)より大きい。
    const viewport = { left: 0, top: 0, width: 390, height: 700 };
    const view = clampView({ scale: 2, tx: -500, ty: 0 }, layout, viewport);
    // 両端とも隙間ができない範囲に収まっているので、そのまま通る。
    expect(view.tx).toBeCloseTo(-500, 5);
  });

  it("紙が画面より大きい軸で、隙間ができる位置を渡すと隙間ができない位置まで戻される", () => {
    const viewport = { left: 0, top: 0, width: 390, height: 700 };
    // 右へ動かしすぎて左端に隙間ができる位置(tx が大きすぎる)。
    const tooRight = clampView({ scale: 2, tx: 99999, ty: 0 }, layout, viewport);
    expect(tooRight.tx).toBeCloseTo(-layout.left, 5);
    expect(layout.left + tooRight.tx).toBeCloseTo(0, 5); // 紙の左端 = 画面の左端

    // 左へ動かしすぎて右端に隙間ができる位置(tx が小さすぎる)。
    const tooLeft = clampView({ scale: 2, tx: -99999, ty: 0 }, layout, viewport);
    const rightEdge = layout.left + tooLeft.tx + layout.width * 2;
    expect(rightEdge).toBeCloseTo(viewport.width, 5); // 紙の右端 = 画面の右端
  });

  it("拡大中に紙を画面外へ飛ばせない(どちらの端にも隙間ができない)", () => {
    const viewport = { left: 0, top: 0, width: 1000, height: 700 };
    const view = clampView(panBy({ scale: 3, tx: 0, ty: 0 }, -99999, -99999), tabletLayout, viewport);
    // 紙の右端は画面の右端より左には来ない(隙間ができない)。
    const rightEdge = tabletLayout.left + view.tx + tabletLayout.width * 3;
    expect(rightEdge).toBeGreaterThanOrEqual(viewport.width - 0.001);
    // 紙の左端は画面の左端より右には来ない。
    expect(tabletLayout.left + view.tx).toBeLessThanOrEqual(0.001);
  });
});
