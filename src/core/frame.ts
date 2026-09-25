// マンガの「わく」(コマ割り)の種類。ツールバーの「マス」から選ぶ。docs/manga.md。
//
// マスの下敷き(grid.ts)と違い、わくは絵に焼き込む線なので別のデータとして持つが、
// 「お手本から選ぶ」表の作り方は GRID_MODES/GRID_MODE_ORDER と揃える。
import type { LabelPart } from "./tools.ts";

/**
 * コマ割りを表す木。葉が 1 コマ、split が矩形を n 個(2 個以上)に割る操作。
 * 「ゆびで きる」(docs/manga.md「後回しにするもの」)は葉を 2 個分けの split に
 * 差し替えるか、親の split に子を 1 つ挿すだけで届くように、最初から「割った木」で持つ。
 * お手本(FRAME_PRESETS)もこの木の出来合い。
 *
 * 2 分割の入れ子(旧形式)だと、割るたびに間(gap)を引くので下のコマほど少しずつ
 * 小さくなり、4 コマの高さが揃わない。n 個分けなら間を先にまとめて引き、残りを
 * sizes の比で分けるだけなので、比が等しければ必ずぴったり等分になる。
 *
 * axis "y" = 上下に積む(children[0] が上)。axis "x" = 左右に並べる(children[0] が左)。
 * sizes は children と同じ長さで、各要素は子の大きさの比(正の数。合計は 1 でなくてよい)。
 */
export type FrameNode =
  | { kind: "leaf" }
  | { kind: "split"; axis: "x" | "y"; sizes: number[]; children: FrameNode[] };

export interface FrameData {
  /** 紙の外周の余白。紙の短辺に対する割合。 */
  margin: number;
  /**
   * 上下に割ったときの間(段と段の間)。短辺に対する割合。
   * 横の間(gapCol)より広く取る: 段の間を広くするのがマンガの読み順の目印になる。
   */
  gapRow: number;
  /** 左右に割ったときの間。短辺に対する割合。 */
  gapCol: number;
  /** 枠線の太さ。短辺に対する割合。 */
  lineWidth: number;
  root: FrameNode;
}

/** お手本の既定値。個々のお手本もここから組み立てる。 */
const DEFAULT_FRAME_METRICS = { margin: 0.06, gapRow: 0.03, gapCol: 0.015, lineWidth: 0.004 };

export type FramePresetId = "none" | "yonkoma" | "nidan";

export interface FramePresetDef {
  id: FramePresetId;
  label: LabelPart[];
  iconSvg: string;
  /** null は「わくなし」(今までの作品はすべてこれ)。 */
  frame: FrameData | null;
}

export const FRAME_PRESETS: Readonly<Record<FramePresetId, FramePresetDef>> = {
  // 既定。わくを敷かない。
  none: {
    id: "none",
    label: [{ base: "なし" }],
    // grid.ts の off(下敷きなし)と同じ、斜線だけの絵。
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M9 23L23 9" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    frame: null,
  },
  // 4 段 1 列(4 コマまんが 1 本)。y を 4 個分け、sizes はすべて等しいので 4 等分。
  yonkoma: {
    id: "yonkoma",
    label: [{ base: "4" }, { base: "こま" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="3" width="20" height="26" rx="2" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M6 9.5h20M6 16h20M6 22.5h20" stroke="#3d3730" stroke-width="1.6"/>
    </svg>`,
    frame: {
      ...DEFAULT_FRAME_METRICS,
      root: {
        kind: "split",
        axis: "y",
        sizes: [1, 1, 1, 1],
        children: [{ kind: "leaf" }, { kind: "leaf" }, { kind: "leaf" }, { kind: "leaf" }],
      },
    },
  },
  // 2 段(上下それぞれ 2 コマずつ)。y を半分、その上下それぞれを x で半分。
  nidan: {
    id: "nidan",
    label: [{ base: "2" }, { base: "だん" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="3" width="20" height="26" rx="2" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M6 16h20M16 3v11.5M16 18.5v11.5" stroke="#3d3730" stroke-width="1.6"/>
    </svg>`,
    frame: {
      ...DEFAULT_FRAME_METRICS,
      root: {
        kind: "split",
        axis: "y",
        sizes: [1, 1],
        children: [
          { kind: "split", axis: "x", sizes: [1, 1], children: [{ kind: "leaf" }, { kind: "leaf" }] },
          { kind: "split", axis: "x", sizes: [1, 1], children: [{ kind: "leaf" }, { kind: "leaf" }] },
        ],
      },
    },
  },
};

export const FRAME_PRESET_ORDER: readonly FramePresetId[] = ["none", "yonkoma", "nidan"];

/** コマ 1 つの矩形(px)。整数に丸める必要はない。 */
export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 木を辿って 1 つの矩形を左右または上下に n 個へ割る。割られる長さから先に
 * gap × (子の数 - 1) を引き、残りを sizes の比で分ける。子と子の間はちょうど gap。
 * gap・margin は呼び出し元で px に換算済みのものを渡す。
 */
function collectPanels(node: FrameNode, rect: Rect, gapRowPx: number, gapColPx: number, out: PanelRect[]): void {
  if (node.kind === "leaf") {
    if (rect.width > 0 && rect.height > 0) out.push(rect);
    return;
  }
  const count = node.children.length;
  const sizeSum = node.sizes.reduce((sum, size) => sum + size, 0);
  if (node.axis === "y") {
    const gap = gapRowPx;
    const available = rect.height - gap * (count - 1);
    const children: Rect[] = [];
    let y = rect.y;
    for (let i = 0; i < count; i += 1) {
      const h = (available * node.sizes[i]!) / sizeSum;
      children.push({ x: rect.x, y, width: rect.width, height: h });
      y += h + gap;
    }
    // 読み順は上から下へ。
    for (let i = 0; i < count; i += 1) collectPanels(node.children[i]!, children[i]!, gapRowPx, gapColPx, out);
  } else {
    const gap = gapColPx;
    const available = rect.width - gap * (count - 1);
    const children: Rect[] = [];
    let x = rect.x;
    for (let i = 0; i < count; i += 1) {
      const w = (available * node.sizes[i]!) / sizeSum;
      children.push({ x, y: rect.y, width: w, height: rect.height });
      x += w + gap;
    }
    // 読み順は同じ段の中では右から左。children を逆順に辿る。
    for (let i = count - 1; i >= 0; i -= 1) collectPanels(node.children[i]!, children[i]!, gapRowPx, gapColPx, out);
  }
}

/**
 * わくの木から、紙の実寸(width x height、px)でコマの矩形一覧を返す。
 * 返す順は **マンガの読み順**: 上の段から下へ、同じ段の中では右から左。
 * margin・gap は短辺(min(width,height))に対する割合として px に換算する。
 * 幅か高さが 0 以下になった葉は返さない(お手本の割合と紙の寸法の組み合わせ次第で
 * gap が margin を食い尽くすような極端な入力でも、壊れず何も返さないだけにする)。
 */
export function framePanels(frame: FrameData, width: number, height: number): PanelRect[] {
  const short = Math.min(width, height);
  const marginPx = frame.margin * short;
  const gapRowPx = frame.gapRow * short;
  const gapColPx = frame.gapCol * short;
  const inner: Rect = {
    x: marginPx,
    y: marginPx,
    width: width - marginPx * 2,
    height: height - marginPx * 2,
  };
  const out: PanelRect[] = [];
  collectPanels(frame.root, inner, gapRowPx, gapColPx, out);
  return out;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 1 つの split が持てる子の数の上限。子の総数が爆発しないための歯止め。 */
const MAX_SPLIT_CHILDREN = 64;

function isFrameNode(value: unknown, depth: number): value is FrameNode {
  if (depth > 16) return false;
  if (typeof value !== "object" || value === null) return false;
  const node = value as { kind?: unknown; axis?: unknown; sizes?: unknown; children?: unknown };
  if (node.kind === "leaf") return true;
  if (node.kind !== "split") return false;
  if (node.axis !== "x" && node.axis !== "y") return false;
  if (!Array.isArray(node.children) || !Array.isArray(node.sizes)) return false;
  const count = node.children.length;
  if (count < 2 || count > MAX_SPLIT_CHILDREN) return false;
  if (node.sizes.length !== count) return false;
  if (!node.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) return false;
  return node.children.every((child) => isFrameNode(child, depth + 1));
}

/** 保存データを読むときの検査。壊れた値で描画が壊れないよう、疑わしければ false。 */
export function isFrameData(value: unknown): value is FrameData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<FrameData>;
  if (!isFiniteNonNegative(data.margin)) return false;
  if (!isFiniteNonNegative(data.gapRow)) return false;
  if (!isFiniteNonNegative(data.gapCol)) return false;
  if (!isFiniteNonNegative(data.lineWidth)) return false;
  return isFrameNode(data.root, 0);
}
