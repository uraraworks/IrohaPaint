import { describe, expect, it } from "vitest";
import { toCanvasPoint } from "../src/core/pointerInput.ts";

describe("toCanvasPoint", () => {
  const rect = { left: 100, top: 50, width: 874, height: 590 }; // 実解像度の半分で表示

  it("表示座標を実解像度へ拡大する", () => {
    expect(toCanvasPoint(100, 50, rect, 1748, 1181)).toEqual({
      x: 0,
      y: 0,
      time: 0,
      pressure: undefined,
    });
    const center = toCanvasPoint(100 + 437, 50 + 295, rect, 1748, 1181);
    expect(center.x).toBeCloseTo(874, 0);
    expect(center.y).toBeCloseTo(590.5, 0);
  });

  it("大きさゼロでも落ちない(レイアウト前の呼び出し)", () => {
    expect(toCanvasPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 1748, 1181)).toEqual({
      x: 0,
      y: 0,
      time: 0,
      pressure: undefined,
    });
  });
});
