import { describe, expect, it } from "vitest";
import {
  NIB_DEFS,
  pressureRatio,
  strokeWidth,
  taperRatio,
  shiftColor,
  widthRatioForSpeed,
} from "../src/core/brush.ts";
import { nearestBeadColor } from "../src/core/palette.ts";

const gpen = NIB_DEFS.gpen.dynamics;
const crayon = NIB_DEFS.crayon.dynamics;

describe("widthRatioForSpeed", () => {
  it("止まっているときがいちばん太い", () => {
    expect(widthRatioForSpeed(gpen, 0)).toBe(gpen.maxWidthRatio);
  });

  it("速く動かすほど細くなり、下限で止まる", () => {
    const slow = widthRatioForSpeed(gpen, 0.5);
    const fast = widthRatioForSpeed(gpen, 2.0);
    expect(fast).toBeLessThan(slow);
    expect(widthRatioForSpeed(gpen, 999)).toBeCloseTo(gpen.minWidthRatio, 10);
  });

  it("クレヨンは速さで太さが変わらない", () => {
    expect(widthRatioForSpeed(crayon, 0)).toBe(1);
    expect(widthRatioForSpeed(crayon, 999)).toBe(1);
  });
});

describe("taperRatio", () => {
  it("端は細く、離れるほど太い", () => {
    expect(taperRatio(0, 40)).toBeLessThan(taperRatio(20, 40));
    expect(taperRatio(40, 40)).toBe(1);
  });

  it("端でも 0 にはしない(線が途切れて見えるため)", () => {
    expect(taperRatio(0, 40)).toBeGreaterThan(0);
  });

  it("入り抜きを使わないペン先では常に 1", () => {
    expect(taperRatio(0, 0)).toBe(1);
  });
});

describe("pressureRatio", () => {
  it("筆圧が取れない環境では効かない", () => {
    expect(pressureRatio(gpen, undefined)).toBe(1);
    // マウスは押下中つねに 0.5 を返すのでセンサー無し扱い
    expect(pressureRatio(gpen, 0.5)).toBe(1);
  });

  it("強く押すほど太い", () => {
    expect(pressureRatio(gpen, 0.9)).toBeGreaterThan(pressureRatio(gpen, 0.2));
  });

  it("筆圧を使わないペン先では効かない", () => {
    expect(pressureRatio(crayon, 0.9)).toBe(1);
  });
});

describe("strokeWidth", () => {
  it("クレヨンは常に基準の太さ", () => {
    expect(strokeWidth(26, crayon, 0, undefined, 0, 0)).toBe(26);
    expect(strokeWidth(26, crayon, 5, 0.9, 3, 3)).toBe(26);
  });

  it("Ｇペンは線の途中がいちばん太く、両端は細い", () => {
    const middle = strokeWidth(26, gpen, 0.2, undefined, 500, 500);
    const start = strokeWidth(26, gpen, 0.2, undefined, 0, 500);
    const end = strokeWidth(26, gpen, 0.2, undefined, 500, 0);
    expect(start).toBeLessThan(middle);
    expect(end).toBeLessThan(middle);
  });

  it("どれだけ細くなっても消えない", () => {
    expect(strokeWidth(26, gpen, 999, undefined, 0, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("nearestBeadColor", () => {
  it("ビーズにある色はそのまま", () => {
    expect(nearestBeadColor("#e4322b")).toBe("#e4322b");
  });

  it("無い色はいちばん近いビーズ色に寄せる", () => {
    // クレヨンの赤 → ビーズの赤
    expect(nearestBeadColor("#e2544a")).toBe("#e4322b");
    // 紙の色に近いごく薄い色 → しろ
    expect(nearestBeadColor("#fffdf7")).toBe("#ffffff");
  });
});

describe("shiftColor", () => {
  it("0 なら色は変わらない", () => {
    expect(shiftColor("#4aa3df", 0)).toBe("#4aa3df");
  });

  it("正で明るく、負で暗くなる", () => {
    expect(shiftColor("#808080", 0.5)).toBe("#c0c0c0");
    expect(shiftColor("#808080", -0.5)).toBe("#404040");
  });

  it("振り切っても 0..255 を外れない", () => {
    expect(shiftColor("#ffffff", 1)).toBe("#ffffff");
    expect(shiftColor("#000000", -1)).toBe("#000000");
  });
});

describe("ペン先の質感", () => {
  it("色鉛筆は粒、油絵は筋、他は 1 本線", () => {
    expect(NIB_DEFS.pencil.dynamics.texture).toBe("pencil");
    expect(NIB_DEFS.oil.dynamics.texture).toBe("oil");
    expect(NIB_DEFS.crayon.dynamics.texture).toBe("smooth");
  });

  it("色鉛筆と油絵は入り抜きを持たない(重ねて描く道具なので)", () => {
    expect(NIB_DEFS.pencil.dynamics.taperOutPx).toBe(0);
    expect(NIB_DEFS.oil.dynamics.taperOutPx).toBe(0);
  });
});
