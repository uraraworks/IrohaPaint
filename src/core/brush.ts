// ペン先(nib)の種類と、線の太さの決まり方。
//
// 筆圧センサーが無い環境でも「Gペンっぽさ」は作れる。効く順に:
//   1. 速さ→太さ … 速く動かすと細く、ゆっくりだと太い。「シャッと抜ける」感触の正体
//   2. 入り抜き   … 描き始めと描き終わりを細くする。無いと線が「棒」に見える
//   3. 手ブレ補正 … 座標を平滑化する。子どもの手のブレを吸収する効果が大きい
// スタイラス(Apple Pencil 等)で本物の筆圧が取れるときはそちらを優先し、
// 取れないときだけ速さで代用する。
//
// ここは純粋な計算だけを置き、描画は surface.ts が行う(vitest で検証できるように)。
import type { LabelPart } from "./tools.ts";

export type NibId = "crayon" | "gpen" | "brush";

export interface NibDynamics {
  /** いちばん速く動かしたときの太さ(基準太さに対する倍率)。 */
  minWidthRatio: number;
  /** 止まっているときの太さ(同上)。 */
  maxWidthRatio: number;
  /** この速さ(キャンバス px / ms)で最も細くなる。 */
  speedForMin: number;
  /** 描き始め / 描き終わりを細くする距離(キャンバス px)。 */
  taperInPx: number;
  taperOutPx: number;
  /** 手ブレ補正の強さ(0=かけない, 1に近いほど遅れて滑らか)。 */
  smoothing: number;
  /** 筆圧が取れるときに使うか。 */
  usePressure: boolean;
}

export interface NibDef {
  id: NibId;
  label: LabelPart[];
  iconSvg: string;
  dynamics: NibDynamics;
}

export const NIB_DEFS: Readonly<Record<NibId, NibDef>> = {
  // 既定。太さが動かないので「思ったところに思った太さで出る」。
  // 説明なしで描き始める子が最初に触るのはこれ。
  crayon: {
    id: "crayon",
    label: [{ base: "クレヨン" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 24c6-2 10-8 16-16" fill="none" stroke="#3d3730" stroke-width="6"
        stroke-linecap="round"/>
    </svg>`,
    dynamics: {
      minWidthRatio: 1,
      maxWidthRatio: 1,
      speedForMin: 1,
      taperInPx: 0,
      taperOutPx: 0,
      smoothing: 0.2,
      usePressure: false,
    },
  },
  // マンガのGペン。速さで大きく太さが変わり、入り抜きが強い。
  gpen: {
    id: "gpen",
    label: [{ base: "Ｇペン" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 26c7-3 12-10 20-20" fill="none" stroke="#3d3730" stroke-width="2"
        stroke-linecap="round"/>
      <path d="M7 25c6-2 11-8 17-16" fill="none" stroke="#3d3730" stroke-width="7"
        stroke-linecap="round" opacity="0.18"/>
    </svg>`,
    dynamics: {
      minWidthRatio: 0.3,
      maxWidthRatio: 1.25,
      speedForMin: 2.6,
      taperInPx: 45,
      taperOutPx: 60,
      smoothing: 0.38,
      usePressure: true,
    },
  },
  // 筆。ゆっくり動かすとぐっと太る。抜きは短く、線幅の幅が広い。
  brush: {
    id: "brush",
    label: [{ base: "筆", ruby: "ふで" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 25c7-3 11-9 18-18" fill="none" stroke="#3d3730" stroke-width="10"
        stroke-linecap="round" opacity="0.25"/>
      <path d="M8 24c6-3 10-8 16-16" fill="none" stroke="#3d3730" stroke-width="4"
        stroke-linecap="round"/>
    </svg>`,
    dynamics: {
      minWidthRatio: 0.55,
      maxWidthRatio: 1.7,
      speedForMin: 2.0,
      taperInPx: 25,
      taperOutPx: 40,
      smoothing: 0.42,
      usePressure: true,
    },
  },
};

export const NIB_ORDER: readonly NibId[] = ["crayon", "gpen", "brush"];

export function isNibId(value: unknown): value is NibId {
  return typeof value === "string" && value in NIB_DEFS;
}

/** 速さ(px/ms)から太さ倍率を出す。速いほど細い。 */
export function widthRatioForSpeed(dynamics: NibDynamics, speed: number): number {
  if (dynamics.speedForMin <= 0) return dynamics.maxWidthRatio;
  const t = Math.min(1, Math.max(0, speed / dynamics.speedForMin));
  return dynamics.maxWidthRatio + (dynamics.minWidthRatio - dynamics.maxWidthRatio) * t;
}

/**
 * 入り抜きの倍率。線の端から distance だけ入った位置での細さ。
 * 端は 0 ではなく細い線として残す(完全に 0 だと点が消えて線が途切れて見える)。
 */
export function taperRatio(distance: number, taperPx: number, minRatio = 0.18): number {
  if (taperPx <= 0) return 1;
  const t = Math.min(1, Math.max(0, distance / taperPx));
  return minRatio + (1 - minRatio) * t;
}

/**
 * 筆圧の反映。取れない環境では 1(＝速さの計算だけに任せる)。
 * PointerEvent.pressure はマウスだと押下時 0.5 固定で返るため、
 * 「0.5 ぴったり」はセンサー無しとみなす。
 */
export function pressureRatio(dynamics: NibDynamics, pressure: number | undefined): number {
  if (!dynamics.usePressure || pressure === undefined) return 1;
  if (pressure <= 0 || pressure === 0.5) return 1;
  return 0.45 + pressure * 1.1;
}

/** 速さ・筆圧・入り抜きをまとめた最終的な太さ(px)。 */
export function strokeWidth(
  baseWidth: number,
  dynamics: NibDynamics,
  speed: number,
  pressure: number | undefined,
  distanceFromStart: number,
  distanceFromEnd: number,
): number {
  const ratio =
    widthRatioForSpeed(dynamics, speed) *
    pressureRatio(dynamics, pressure) *
    taperRatio(distanceFromStart, dynamics.taperInPx) *
    taperRatio(distanceFromEnd, dynamics.taperOutPx);
  // 細くなりすぎて消えないよう下限を置く。
  return Math.max(1, baseWidth * ratio);
}
