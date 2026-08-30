// 紙の種類と、その質感テクスチャの生成。
//
// grid.ts の「種類を表で持つ」書き方にそのまま合わせる。UI 配線は次の作業で行うので、
// ここでは「種類の定義」と「質感を描いたキャンバスを作る関数」だけを用意する。
import type { LabelPart } from "./tools.ts";

export type PaperKind = "plain" | "straw" | "canvas";

export interface PaperKindDef {
  id: PaperKind;
  label: LabelPart[];
  iconSvg: string;
}

export const PAPER_KINDS: Readonly<Record<PaperKind, PaperKindDef>> = {
  // 既定。質感の無いふつうの白紙(createPaperTexture は null を返す)。
  plain: {
    id: "plain",
    label: [{ base: "普通", ruby: "ふつう" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="4" width="20" height="24" rx="2" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
    </svg>`,
  },
  // わら半紙。紙に混じった繊維を点々で表す。
  straw: {
    id: "straw",
    label: [{ base: "わら" }, { base: "半紙", ruby: "はんし" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="4" width="20" height="24" rx="2" fill="#f5ecc9" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M11 10L14 11.5M18 9.5L20.5 11M10.5 16L13 17M20 15.5L22.5 16.5M12 22L14.5 23"
        stroke="#a8925a" stroke-width="1.2" stroke-linecap="round" opacity="0.75"/>
      <circle cx="17" cy="18" r="0.9" fill="#a8925a" opacity="0.7"/>
      <circle cx="22" cy="21" r="0.9" fill="#a8925a" opacity="0.7"/>
      <circle cx="9.5" cy="21" r="0.9" fill="#a8925a" opacity="0.7"/>
    </svg>`,
  },
  // キャンバス地。織り目を格子で表す。
  canvas: {
    id: "canvas",
    label: [{ base: "キャンバス" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="6" y="4" width="20" height="24" rx="2" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M9 4v24M13 4v24M17 4v24M21 4v24M6 8h20M6 12h20M6 16h20M6 20h20M6 24h20"
        stroke="#3d3730" stroke-width="0.9" opacity="0.35"/>
    </svg>`,
  },
};

export const PAPER_KIND_ORDER: readonly PaperKind[] = ["plain", "straw", "canvas"];

export function isPaperKind(value: unknown): value is PaperKind {
  return typeof value === "string" && value in PAPER_KINDS;
}

/**
 * 紙の質感を描いたキャンバスを作る。plain は質感が無いので null を返す。
 * 呼び出し側はこれを「乗算」で重ねて使う(画面表示と書き出しの両方で同じものを使うので、
 * 見た目と出力がずれない)。
 *
 * 画像ファイルは使わずその場で描く(キャンバスサイズが将来変わっても破綻しないため)。
 * 乗算前提なので質感の無いところは白(#ffffff、乗算しても変化しない)にし、
 * 質感のあるところだけ暗い色を薄く重ねる。線画が読めなくなるほど濃くはしない。
 */
export function createPaperTexture(
  kind: PaperKind,
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas | null {
  if (kind === "plain") return null;

  // OffscreenCanvas があればそれを使い、無ければ通常の canvas 要素にフォールバック
  // (underlayImport.ts の encodeToBlob と同じ判断)。
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  if (!(canvas instanceof OffscreenCanvas)) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return null;

  // まずは無地(乗算で変化しない白)で塗りつぶす。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  if (kind === "straw") {
    drawStrawTexture(ctx, width, height);
  } else if (kind === "canvas") {
    drawCanvasTexture(ctx, width, height);
  }

  return canvas;
}

/**
 * わら半紙: 全体にごく薄い黄ばみ(乗算でわずかに沈める程度)を敷き、
 * そこへ繊維のような短い線と粒を散らす。
 *
 * 実機(表示倍率 0.51 相当に縮小した状態)で標準偏差が 2〜6 に収まるよう、
 * 繊維は 6〜14px の短い線にして「縮小しても粒として残る」密度・濃さにしてある。
 * 濃さの目安: 地の黄ばみは alpha 0.04(ほぼ気付かない程度)、
 * 繊維・粒は alpha 0.16〜0.26 で、線画の黒(乗算で重なっても読める濃さ)より
 * 十分薄い。子どもの絵が沈まないことを最優先にしている。
 */
function drawStrawTexture(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  // 地の黄ばみ。ごく薄いのでベタ塗りで十分。
  ctx.fillStyle = "rgba(196, 168, 96, 0.04)";
  ctx.fillRect(0, 0, width, height);

  // 疑似乱数(毎回同じ結果になるよう決め打ちのシードで生成する。実行ごとに絵が
  // ちらつくのを避けるため)。
  let seed = 20260830;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  // 短い繊維。1本を6〜14pxの線にし、縮小後も粒として視認できる長さを確保する。
  // 密度は 1800px^2 あたり約1本(旧: 10000px^2 あたり1本から大幅に増やした)。
  const fiberCount = Math.round((width * height) / 1800);
  ctx.strokeStyle = "rgba(130, 98, 46, 0.30)";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (let i = 0; i < fiberCount; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const len = 6 + rand() * 8;
    const angle = rand() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  // 小さな粒。繊維よりさらに疎ら。
  const speckCount = Math.round((width * height) / 6000);
  ctx.fillStyle = "rgba(130, 98, 46, 0.34)";
  for (let i = 0; i < speckCount; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = 0.9 + rand() * 1.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * キャンバス地: 等間隔の帯を縦横に重ねて布目を作る。
 *
 * 実際の表示は原寸(1748x1181)ではなく縮小して見えるため(表示倍率およそ 0.51)、
 * 周期が細かすぎると縞が表示解像度を下回って干渉し、大きくぼやけた市松模様
 * (モアレ)になってしまう。そのため周期は 12px(表示倍率 0.51 で画面上 1 周期
 * 約 6px となり干渉しない)とし、はがき印刷(1748px=148mm)換算でも
 * 約 1.0mm と実物の油彩キャンバスの織り目として妥当な太さにしてある。
 *
 * また 1px の硬い線のままだと縮小時に消えたり跳ねたりして安定しないため、
 * 太め(2.4px)の縞を描いたあと ctx.filter でぼかし、縁がなめらかな帯にする。
 * 濃さの目安: 縞は alpha 0.10。縦横の交点は乗算的に少し濃くなるが、
 * ぼかし後の合成濃さはおおむね alpha 0.15 相当に収まり、線画を邪魔しない。
 */
function drawCanvasTexture(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const pitch = 12; // 織り目の間隔(px)。表示縮小時に干渉しない太さまで広げた。
  ctx.strokeStyle = "rgba(80, 70, 55, 0.1)";
  ctx.lineWidth = 2.4;

  // ぼかしをかけて縁をなめらかにする(対応していない環境では filter が
  // 無視され、硬い縞のまま描かれるだけなので安全側に倒れる)。
  const prevFilter = ctx.filter;
  ctx.filter = "blur(1.4px)";

  for (let x = 0.5; x < width; x += pitch) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0.5; y < height; y += pitch) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.filter = prevFilter;
}
