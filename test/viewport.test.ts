import { describe, expect, it } from "vitest";
import {
  clampView,
  IDENTITY,
  isFullyVisible,
  MAX_SCALE,
  panBy,
  visibleRect,
  zoomAt,
} from "../src/core/viewport.ts";

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

describe("visibleRect / isFullyVisible", () => {
  // タブレット相当: 紙(800x540)が画面(1000x700)に収まる。
  const tabletViewport = { left: 0, top: 0, width: 1000, height: 700 };
  const tabletLayout = {
    left: (tabletViewport.width - layout.width) / 2,
    top: (tabletViewport.height - layout.height) / 2,
    width: layout.width,
    height: layout.height,
  };

  it("紙が全部見えているとき、見えている範囲が 0,0,1,1 になる", () => {
    const rect = visibleRect(IDENTITY, tabletLayout, tabletViewport);
    expect(rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(isFullyVisible(rect)).toBe(true);
  });

  it("拡大して中央にいるとき、範囲が中央の一部になる", () => {
    // スマホ相当: 紙(800x540)を2倍(1600x1080)、画面(390x700)より大きい。
    // ちょうど中央に来る tx/ty を計算する(紙の中心 = 画面の中心)。
    const scale = 2;
    const viewport = { left: 0, top: 0, width: 390, height: 700 };
    const paperCenterX = layout.left + (layout.width * scale) / 2;
    const paperCenterY = layout.top + (layout.height * scale) / 2;
    const viewportCenterX = viewport.left + viewport.width / 2;
    const viewportCenterY = viewport.top + viewport.height / 2;
    const view = {
      scale,
      tx: viewportCenterX - paperCenterX,
      ty: viewportCenterY - paperCenterY,
    };
    const clamped = clampView(view, layout, viewport);
    const rect = visibleRect(clamped, layout, viewport);

    // 中央に来ているので、見えている範囲の中心は紙の中心(0.5, 0.5)に一致する。
    expect(rect.x + rect.w / 2).toBeCloseTo(0.5, 5);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 5);
    // 横幅は画面(390)/紙の実寸(800*2=1600)分だけ見えている。
    expect(rect.w).toBeCloseTo(390 / 1600, 5);
    // 縦は画面(700)のほうが紙の実寸(540*2=1080)より小さいので一部だけ。
    expect(rect.h).toBeCloseTo(700 / 1080, 5);
    expect(isFullyVisible(rect)).toBe(false);
  });

  it("端まで寄せたとき、範囲が 0 側/1 側に張り付き、はみ出さない", () => {
    const scale = 2;
    const viewport = { left: 0, top: 0, width: 390, height: 700 };
    // 右へ思い切り動かす(紙の左側が見える状態)→ clampView で隙間なしに丸められる。
    const rightmost = clampView({ scale, tx: 99999, ty: 0 }, layout, viewport);
    const rectRight = visibleRect(rightmost, layout, viewport);
    expect(rectRight.x).toBeCloseTo(0, 5);
    expect(rectRight.x).toBeGreaterThanOrEqual(0);
    expect(rectRight.x + rectRight.w).toBeLessThanOrEqual(1 + 1e-9);

    // 左へ思い切り動かす(紙の右側が見える状態)。
    const leftmost = clampView({ scale, tx: -99999, ty: 0 }, layout, viewport);
    const rectLeft = visibleRect(leftmost, layout, viewport);
    expect(rectLeft.x + rectLeft.w).toBeCloseTo(1, 5);
    expect(rectLeft.x).toBeGreaterThanOrEqual(0);
    expect(rectLeft.x + rectLeft.w).toBeLessThanOrEqual(1 + 1e-9);
  });
});
