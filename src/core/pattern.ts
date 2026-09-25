// 「塗る」のもよう(トーン)。ツールバーの「塗る」パネルに、かこみ/しかく/まる の行に
// 続く 2 行目として並ぶ(docs/manga.md「決めたこと:トーン」)。
//
// grid.ts / frame.ts と同じ作法: id をキーにした Readonly<Record> + 表示順の配列で持ち、
// お手本から選ぶ形にする。
import type { LabelPart } from "./tools.ts";

export type PatternId = "solid" | "dots-light" | "dots" | "dots-dark" | "stripes" | "mesh";

export interface PatternDef {
  id: PatternId;
  label: LabelPart[];
  iconSvg: string;
}

export const PATTERNS: Readonly<Record<PatternId, PatternDef>> = {
  // 既定。もようなし(今までどおりのべた塗り)。わくの行の「わくなし」と表記を揃える。
  solid: {
    id: "solid",
    label: [{ base: "もようなし" }],
    // grid.ts の off(下敷きなし)と同じ、斜線だけの絵。
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M9 23L23 9" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
  },
  "dots-light": {
    id: "dots-light",
    label: [{ base: "うすい" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <circle cx="11" cy="11" r="1.6" fill="#3d3730"/>
      <circle cx="21" cy="11" r="1.6" fill="#3d3730"/>
      <circle cx="11" cy="21" r="1.6" fill="#3d3730"/>
      <circle cx="21" cy="21" r="1.6" fill="#3d3730"/>
      <circle cx="16" cy="16" r="1.6" fill="#3d3730"/>
    </svg>`,
  },
  dots: {
    id: "dots",
    label: [{ base: "てんてん" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <circle cx="11" cy="11" r="2.6" fill="#3d3730"/>
      <circle cx="21" cy="11" r="2.6" fill="#3d3730"/>
      <circle cx="11" cy="21" r="2.6" fill="#3d3730"/>
      <circle cx="21" cy="21" r="2.6" fill="#3d3730"/>
      <circle cx="16" cy="16" r="2.6" fill="#3d3730"/>
    </svg>`,
  },
  "dots-dark": {
    id: "dots-dark",
    label: [{ base: "こい" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <circle cx="11" cy="11" r="3.8" fill="#3d3730"/>
      <circle cx="21" cy="11" r="3.8" fill="#3d3730"/>
      <circle cx="11" cy="21" r="3.8" fill="#3d3730"/>
      <circle cx="21" cy="21" r="3.8" fill="#3d3730"/>
      <circle cx="16" cy="16" r="3.8" fill="#3d3730"/>
    </svg>`,
  },
  stripes: {
    id: "stripes",
    label: [{ base: "しましま" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M5 21L21 5M5 27L27 5M11 27L27 11" stroke="#3d3730" stroke-width="2.2"
        stroke-linecap="round"/>
    </svg>`,
  },
  mesh: {
    id: "mesh",
    label: [{ base: "あみあみ" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M5 21L21 5M5 27L27 5M11 27L27 11" stroke="#3d3730" stroke-width="1.6"
        stroke-linecap="round"/>
      <path d="M27 21L11 5M27 27L5 5M21 27L5 11" stroke="#3d3730" stroke-width="1.6"
        stroke-linecap="round"/>
    </svg>`,
  },
};

export const PATTERN_ORDER: readonly PatternId[] = [
  "solid",
  "dots-light",
  "dots",
  "dots-dark",
  "stripes",
  "mesh",
];

export function isPatternId(value: unknown): value is PatternId {
  return typeof value === "string" && value in PATTERNS;
}

/*
 * もよう(トーン)のタイル寸法。単位はキャンバスの画素(紙の短辺は 1181 か 1748)。
 * B4 をタブレットで見ると紙は約 1/3 に縮む。点の間隔が画面で 5〜6px あれば点として
 * 見える。モアレは実機で見て詰める(docs/manga.md)。
 *
 * タイルは 24x24 の正方形。「タイルの端で継ぎ目が出ない」ことが最優先: 網点は
 * 4 隅+中心の 45° 配置(隣のタイルと繋がって等間隔の格子になる)、線は
 * タイルの外にはみ出す分だけ隣のタイルへそのまま引き継がれるように引く。
 */
const TILE_SIZE = 24;
// 網点は 4隅(間隔 TILE_SIZE)+中心の 45° 配置で、間隔は約 17px(= 24 / √2)になる。
const DOT_RADIUS: Readonly<Record<"dots-light" | "dots" | "dots-dark", number>> = {
  "dots-light": 3,
  dots: 4.5,
  "dots-dark": 6.5,
};
/** しましま/あみあみの線の太さ。 */
const STRIPE_WIDTH = 6;
const MESH_LINE_WIDTH = 3;

/** タイル絵のキャッシュ。(id, color) の組みは 6 種 × 使う色数しかないので上限は気にしない。 */
const tileCache = new Map<string, HTMLCanvasElement>();

/** x + y = c の斜め線(左上がり)を、タイルからはみ出す分も含めて引く。 */
function drawSumDiagonals(ctx: CanvasRenderingContext2D, cs: readonly number[], lineWidth: number): void {
  const span = TILE_SIZE * 2;
  for (const c of cs) {
    ctx.beginPath();
    ctx.moveTo(-span, c + span);
    ctx.lineTo(c + span, -span);
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** x − y = c の斜め線(右上がり)。しましまと逆向き。 */
function drawDiffDiagonals(ctx: CanvasRenderingContext2D, cs: readonly number[], lineWidth: number): void {
  const span = TILE_SIZE * 2;
  for (const c of cs) {
    ctx.beginPath();
    ctx.moveTo(-span, -span - c);
    ctx.lineTo(span, span - c);
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

function drawDotsTile(ctx: CanvasRenderingContext2D, color: string, radius: number): void {
  ctx.fillStyle = color;
  const points: [number, number][] = [
    [0, 0],
    [TILE_SIZE, 0],
    [0, TILE_SIZE],
    [TILE_SIZE, TILE_SIZE],
    [TILE_SIZE / 2, TILE_SIZE / 2],
  ];
  for (const [x, y] of points) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * もようのタイル絵(24x24)を作る。solid(もようなし)は null(=べた塗りのまま)。
 * (id, color) の組みでキャッシュする。
 */
export function patternTile(id: PatternId, color: string): HTMLCanvasElement | null {
  if (id === "solid") return null;
  const key = `${id}:${color}`;
  const cached = tileCache.get(key);
  if (cached !== undefined) return cached;

  const tile = document.createElement("canvas");
  tile.width = TILE_SIZE;
  tile.height = TILE_SIZE;
  const ctx = tile.getContext("2d");
  if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
  ctx.strokeStyle = color;

  switch (id) {
    case "dots-light":
    case "dots":
    case "dots-dark":
      drawDotsTile(ctx, color, DOT_RADIUS[id]);
      break;
    case "stripes":
      drawSumDiagonals(ctx, [0, TILE_SIZE, TILE_SIZE * 2], STRIPE_WIDTH);
      break;
    case "mesh":
      drawSumDiagonals(ctx, [0, TILE_SIZE, TILE_SIZE * 2], MESH_LINE_WIDTH);
      drawDiffDiagonals(ctx, [-TILE_SIZE, 0, TILE_SIZE], MESH_LINE_WIDTH);
      break;
  }

  tileCache.set(key, tile);
  return tile;
}
