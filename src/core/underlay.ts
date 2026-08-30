// 下敷き(取り込んだ画像)のデータモデル。
//
// 下敷きは「なぞる元」であって作品ではない。作品(WorkRecord)と違って
// 編集されず、履歴(snapshots)も持たない。ただし紙のどこにどう置くかは
// 触って変えられるので、その配置(placement)だけは可変として持つ。
import { CANVAS_HEIGHT, CANVAS_WIDTH, createId } from "./model.ts";

/** キャンバス座標系(1748x1181)での置き方。ctx.drawImage(img, tx, ty, width*scale, height*scale) にそのまま渡せる形。 */
export interface UnderlayPlacement {
  scale: number;
  tx: number;
  ty: number;
}

/** 濃さ 3 段階。太さが 5 段階なのと同じ粒度で選ばせる(選択肢が多すぎると子どもは選べない)。 */
export type UnderlayOpacity = "faint" | "normal" | "strong";

export const UNDERLAY_ALPHA: Readonly<Record<UnderlayOpacity, number>> = {
  faint: 0.18,
  normal: 0.35,
  strong: 0.6,
};

export const DEFAULT_UNDERLAY_OPACITY: UnderlayOpacity = "normal";

export function isUnderlayOpacity(value: unknown): value is UnderlayOpacity {
  return value === "faint" || value === "normal" || value === "strong";
}

/** 下敷き 1 枚。取り込んだ画像そのもの＋紙のどこに置くか。 */
export interface UnderlayRecord {
  id: string;
  createdAt: number;
  /** 取り込んだ画像(PNG / JPEG)。作品と違って以後書き換わらない。 */
  image: Blob;
  /** image の画素サイズ。配置計算に要るので保存時に確定させる。 */
  width: number;
  height: number;
  placement: UnderlayPlacement;
  opacity: UnderlayOpacity;
  /** 最後に下敷きとして選ばれた時刻(epoch ミリ秒)。古いものから押し出すときの基準。 */
  lastUsedAt: number;
  /** 一覧に並べる小さい画像。原寸(長辺2048)を何枚も並べると一覧を開くだけで数十MB動くため。 */
  thumbnail: Blob;
}

/**
 * 取り込み時に縮小する長辺の上限。
 * キャンバスが 1748px 幅なので 2048 あれば拡大してなぞっても足りる。
 * 実際の縮小(canvas への描画・再エンコード)は取り込み側の仕事で、ここでは寸法計算だけ持つ。
 */
export const UNDERLAY_MAX_EDGE = 2048;

/** 長辺が maxEdge を超えるときだけ縮小した整数寸法を返す。超えなければそのまま。最低 1px。 */
export function fitSize(
  width: number,
  height: number,
  maxEdge = UNDERLAY_MAX_EDGE,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) return { width, height };
  const ratio = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * 画像全体がキャンバスに収まる倍率(contain)で中央寄せした配置を返す。
 * cover ではなく contain にする理由: まず全部見えることが「失敗しない」。
 * 寄せたい所は後から「置く」操作で拡大させる。
 * 画像がキャンバスより小さい場合も contain(＝拡大して収める)でよい。
 */
export function fitPlacement(width: number, height: number): UnderlayPlacement {
  const scale = Math.min(CANVAS_WIDTH / width, CANVAS_HEIGHT / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  return {
    scale,
    tx: (CANVAS_WIDTH - scaledWidth) / 2,
    ty: (CANVAS_HEIGHT - scaledHeight) / 2,
  };
}

/** clampPlacement の倍率クランプ範囲。基準を「収まる倍率」にするのは、画像の画素数に関係なく同じ操作感にするため。 */
export const UNDERLAY_MIN_SCALE_RATIO = 0.25;
export const UNDERLAY_MAX_SCALE_RATIO = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 配置を正常な範囲へ丸める。
 *   - scale: fitPlacement() の倍率(収まる倍率)を基準に MIN〜MAX_SCALE_RATIO 倍の範囲へ。
 *   - tx/ty: 下敷きの矩形が紙の矩形と必ず重なるように(viewport.ts の clampView と同じ発想だが、
 *     あちらは中心基準、こちらは重なり基準)。
 */
export function clampPlacement(
  placement: UnderlayPlacement,
  width: number,
  height: number,
): UnderlayPlacement {
  const fit = fitPlacement(width, height);
  const scale = clamp(
    placement.scale,
    fit.scale * UNDERLAY_MIN_SCALE_RATIO,
    fit.scale * UNDERLAY_MAX_SCALE_RATIO,
  );
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  // 矩形どうしが重なる範囲 = 右端が紙の左端より内側(tx > -scaledWidth)、
  // 左端が紙の右端より内側(tx < CANVAS_WIDTH)。境界(点で接する)までは許す。
  return {
    scale,
    tx: clamp(placement.tx, -scaledWidth, CANVAS_WIDTH),
    ty: clamp(placement.ty, -scaledHeight, CANVAS_HEIGHT),
  };
}

/**
 * キャンバス座標の点 anchor を固定したまま倍率を factor 倍する。
 * viewport.ts の zoomAt と同じ考え方。クランプ後の実効倍率で位置を出す
 * (そうしないと上限で位置がずれる)。
 */
export function scaleAt(
  placement: UnderlayPlacement,
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  factor: number,
): UnderlayPlacement {
  const fit = fitPlacement(width, height);
  const scale = clamp(
    placement.scale * factor,
    fit.scale * UNDERLAY_MIN_SCALE_RATIO,
    fit.scale * UNDERLAY_MAX_SCALE_RATIO,
  );
  // 実際にかかった倍率(クランプ後)。
  const applied = scale / placement.scale;
  const tx = anchorX - applied * (anchorX - placement.tx);
  const ty = anchorY - applied * (anchorY - placement.ty);
  return clampPlacement({ scale, tx, ty }, width, height);
}

export function createUnderlay(
  image: Blob,
  width: number,
  height: number,
  now: number,
  thumbnail: Blob,
): UnderlayRecord {
  return {
    id: createId("under"),
    createdAt: now,
    image,
    width,
    height,
    placement: fitPlacement(width, height),
    opacity: DEFAULT_UNDERLAY_OPACITY,
    // 取り込んだ直後は「今使った」ので lastUsedAt も now にする。
    lastUsedAt: now,
    thumbnail,
  };
}

/**
 * 端末に置いておく下敷きの上限。写真1枚が数MBあるため、無制限に溜めると容量を圧迫する。
 * 下敷きは自分で描いたものではなく元ファイルが手元に残っているので、押し出されても
 * 取り込み直せばよい ＝ 消す操作を画面に置かずに済む(誤って消す事故が起きない)。
 */
export const MAX_UNDERLAYS = 12;

/** 上限を超えている分について、押し出す対象の id を lastUsedAt の古い順に返す。 */
export function pickEvicted(
  records: readonly { id: string; lastUsedAt: number }[],
  max = MAX_UNDERLAYS,
): string[] {
  if (records.length <= max) return [];
  // lastUsedAt 昇順(古い順)。同点は id で決着させ、並び替えのたびに結果が
  // 揺れる(テストが不安定になる)のを防ぐ。
  const sorted = [...records].sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const evictCount = sorted.length - max;
  return sorted.slice(0, evictCount).map((record) => record.id);
}

/**
 * スキーマ変更時に上げる。model.ts の SCHEMA_VERSION とは別に独立して上げられるようにする。
 * 1 → 2: lastUsedAt と thumbnail を必須で足したため、それ以前に保存されたレコードは形が合わない。
 * 下敷きはまだ公開していない機能なので、古いレコードは読まずに捨ててよい(unwrap() が
 * バージョン不一致として無視する)。
 */
export const UNDERLAY_SCHEMA_VERSION = 2;
