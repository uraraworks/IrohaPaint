import { describe, expect, it } from "vitest";
import {
  FRAME_PRESET_ORDER,
  FRAME_PRESETS,
  framePanels,
  framePresetOf,
  isFrameData,
  type FrameData,
} from "../src/core/frame.ts";

const PAPER_LANDSCAPE = { width: 1748, height: 1181 };
const PAPER_PORTRAIT = { width: 1748, height: 2476 };

describe("framePanels", () => {
  it("4 こまは 4 枚を上から順に返し、高さがぴったり揃う", () => {
    const frame = FRAME_PRESETS.yonkoma.frame!;
    const panels = framePanels(frame, PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);

    expect(panels.length).toBe(4);
    for (let i = 1; i < panels.length; i += 1) {
      expect(panels[i]!.y).toBeGreaterThan(panels[i - 1]!.y);
    }
    // n 個分けは間を先にまとめて引いてから比で分けるので、sizes が等しければ
    // 高さはぴったり一致する(浮動小数点誤差のみ)。
    const heights = panels.map((p) => p.height);
    const maxDiff = Math.max(...heights) - Math.min(...heights);
    expect(maxDiff).toBeLessThan(0.001);

    for (const panel of panels) {
      const leftGap = panel.x;
      const rightGap = PAPER_PORTRAIT.width - (panel.x + panel.width);
      expect(leftGap).toBeCloseTo(rightGap, 1);
    }

    // 段と段の間はちょうど gapRow × 短辺。
    const shortSide = Math.min(PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);
    const expectedGap = frame.gapRow * shortSide;
    for (let i = 1; i < panels.length; i += 1) {
      const gap = panels[i]!.y - (panels[i - 1]!.y + panels[i - 1]!.height);
      expect(gap).toBeCloseTo(expectedGap, 6);
    }
  });

  it("2 だんは 4 枚を「右上・左上・右下・左下」の順で返し、幅・高さがぴったり揃う", () => {
    const frame = FRAME_PRESETS.nidan.frame!;
    const panels = framePanels(frame, PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);

    expect(panels.length).toBe(4);
    const [topRight, topLeft, bottomRight, bottomLeft] = panels;
    expect(topRight!.y).toBeCloseTo(topLeft!.y, 6);
    expect(bottomRight!.y).toBeCloseTo(bottomLeft!.y, 6);
    expect(topRight!.y).toBeLessThan(bottomRight!.y);
    expect(topRight!.x).toBeGreaterThan(topLeft!.x);
    expect(bottomRight!.x).toBeGreaterThan(bottomLeft!.x);

    // 4 コマとも幅・高さがそれぞれ一致する。
    const widths = panels.map((p) => p.width);
    const heights = panels.map((p) => p.height);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.001);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.001);

    // 横の間はちょうど gapCol × 短辺。
    const shortSide = Math.min(PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);
    const expectedGapCol = frame.gapCol * shortSide;
    const topGap = topRight!.x - (topLeft!.x + topLeft!.width);
    expect(topGap).toBeCloseTo(expectedGapCol, 6);
  });

  it("段の間(gapRow)は横の間(gapCol)より広い", () => {
    const frame = FRAME_PRESETS.yonkoma.frame!;
    expect(frame.gapRow).toBeGreaterThan(frame.gapCol);
  });

  it("sizes [1,2] は間を引いた残りを 1:2 で分ける", () => {
    const frame: FrameData = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: {
        kind: "split",
        axis: "y",
        sizes: [1, 2],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
    };
    const panels = framePanels(frame, PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);
    expect(panels.length).toBe(2);
    const [top, bottom] = panels;
    // children[0]=上 が sizes[0]、children[1]=下 が sizes[1]。1:2 になるはず。
    expect(bottom!.height / top!.height).toBeCloseTo(2, 6);

    const shortSide = Math.min(PAPER_PORTRAIT.width, PAPER_PORTRAIT.height);
    const marginPx = frame.margin * shortSide;
    const gapPx = frame.gapRow * shortSide;
    const available = PAPER_PORTRAIT.height - marginPx * 2 - gapPx;
    expect(top!.height).toBeCloseTo(available / 3, 6);
    expect(bottom!.height).toBeCloseTo((available * 2) / 3, 6);
  });

  it.each([
    ["横長", PAPER_LANDSCAPE],
    ["縦長", PAPER_PORTRAIT],
  ])("%s の紙でも、すべての矩形が紙の内側(margin 分内側)に収まる", (_label, paper) => {
    for (const preset of Object.values(FRAME_PRESETS)) {
      if (preset.frame === null) continue;
      const frame = preset.frame;
      const panels = framePanels(frame, paper.width, paper.height);
      const marginPx = frame.margin * Math.min(paper.width, paper.height);
      for (const panel of panels) {
        expect(panel.x).toBeGreaterThanOrEqual(marginPx - 0.01);
        expect(panel.y).toBeGreaterThanOrEqual(marginPx - 0.01);
        expect(panel.x + panel.width).toBeLessThanOrEqual(paper.width - marginPx + 0.01);
        expect(panel.y + panel.height).toBeLessThanOrEqual(paper.height - marginPx + 0.01);
      }
    }
  });
});

describe("isFrameData", () => {
  it("全お手本の frame は true", () => {
    for (const preset of Object.values(FRAME_PRESETS)) {
      if (preset.frame === null) continue;
      expect(isFrameData(preset.frame)).toBe(true);
    }
  });

  it("null は false(なしのお手本)", () => {
    expect(isFrameData(null)).toBe(false);
  });

  it("sizes と children の長さが違うと false", () => {
    const frame: FrameData = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: {
        kind: "split",
        axis: "y",
        sizes: [1, 1, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("子が 1 個は false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: { kind: "split", axis: "y", sizes: [1], children: [{ kind: "leaf" }] },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("sizes に 0 があると false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: {
        kind: "split",
        axis: "y",
        sizes: [0, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("sizes に負の数があると false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: {
        kind: "split",
        axis: "y",
        sizes: [-1, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("sizes に NaN があると false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: {
        kind: "split",
        axis: "y",
        sizes: [NaN, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }],
      },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("子が 65 個は false(上限は 64 個)", () => {
    const children = Array.from({ length: 65 }, () => ({ kind: "leaf" as const }));
    const sizes = Array.from({ length: 65 }, () => 1);
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: { kind: "split", axis: "y", sizes, children },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("子が 64 個は true(上限ちょうど)", () => {
    const children = Array.from({ length: 64 }, () => ({ kind: "leaf" as const }));
    const sizes = Array.from({ length: 64 }, () => 1);
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: { kind: "split", axis: "y", sizes, children },
    };
    expect(isFrameData(frame)).toBe(true);
  });

  it("旧形式(at あり、children が 2 要素タプル)は false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: { kind: "split", axis: "y", at: 0.5, children: [{ kind: "leaf" }, { kind: "leaf" }] },
    };
    expect(isFrameData(frame)).toBe(false);
  });

  it("負の margin は false", () => {
    const frame: FrameData = { ...FRAME_PRESETS.yonkoma.frame!, margin: -0.1 };
    expect(isFrameData(frame)).toBe(false);
  });

  it("NaN は false", () => {
    const frame: FrameData = { ...FRAME_PRESETS.yonkoma.frame!, gapRow: NaN };
    expect(isFrameData(frame)).toBe(false);
  });

  it("壊れた木(children が配列でない)は false", () => {
    const frame = {
      margin: 0.06,
      gapRow: 0.03,
      gapCol: 0.015,
      lineWidth: 0.004,
      root: { kind: "split", axis: "y", sizes: [1, 1], children: { kind: "leaf" } },
    };
    expect(isFrameData(frame)).toBe(false);
  });
});

describe("FRAME_PRESET_ORDER", () => {
  it("none を先頭に、全 id を含む", () => {
    expect(FRAME_PRESET_ORDER[0]).toBe("none");
    expect(new Set(FRAME_PRESET_ORDER)).toEqual(new Set(Object.keys(FRAME_PRESETS)));
  });
});

describe("framePresetOf", () => {
  it("全お手本は自分の id を返す", () => {
    for (const id of FRAME_PRESET_ORDER) {
      expect(framePresetOf(FRAME_PRESETS[id].frame ?? undefined)).toBe(id);
    }
  });

  it("undefined は none", () => {
    expect(framePresetOf(undefined)).toBe("none");
  });

  it("お手本と違う中身(sizes を変えたもの)は null", () => {
    const frame: FrameData = {
      ...FRAME_PRESETS.yonkoma.frame!,
      root: {
        kind: "split",
        axis: "y",
        sizes: [1, 1, 1, 2],
        children: [{ kind: "leaf" }, { kind: "leaf" }, { kind: "leaf" }, { kind: "leaf" }],
      },
    };
    expect(framePresetOf(frame)).toBeNull();
  });
});
