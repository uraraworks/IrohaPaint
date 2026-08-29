// キャンバスの見え方(拡大・移動)。
//
// 子どもは写真アプリでピンチを習得済みなので、Phase 0 から入れる。
// 描画そのものは触れた瞬間に始まるまま。指 2 本になった時点で「見る操作」に切り替える。
//
// 変換は CSS transform("translate(tx,ty) scale(s)" / transform-origin: 0 0)。
// 画面座標→キャンバス座標の変換は getBoundingClientRect が変換後の矩形を返すので、
// pointerInput 側は何も知らなくてよい(ここが破綻しない要点)。

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

export const IDENTITY: ViewTransform = { scale: 1, tx: 0, ty: 0 };

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 画面上の点 anchor を固定したまま倍率を factor 倍する。
 * layout は変換前(scale=1, t=0)の要素矩形。
 */
export function zoomAt(
  view: ViewTransform,
  layout: Rect,
  anchorX: number,
  anchorY: number,
  factor: number,
): ViewTransform {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  // 実際にかかった倍率(クランプ後)。これを使わないと上限で位置がずれる。
  const applied = scale / view.scale;
  return {
    scale,
    tx: anchorX - layout.left - applied * (anchorX - layout.left - view.tx),
    ty: anchorY - layout.top - applied * (anchorY - layout.top - view.ty),
  };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy };
}

/**
 * 紙が画面外へ飛んでいかないよう位置を丸める。
 * 等倍(scale=1)なら常に元の位置へ吸着させる … 子どもが紙を見失わないための保険。
 */
export function clampView(view: ViewTransform, layout: Rect, viewportW: number, viewportH: number): ViewTransform {
  if (view.scale <= MIN_SCALE + 0.001) return { scale: MIN_SCALE, tx: 0, ty: 0 };
  const width = layout.width * view.scale;
  const height = layout.height * view.scale;
  // 紙の端が画面の中心より内側へは来られないようにする(端が掴める範囲で自由)。
  const minTx = viewportW * 0.5 - layout.left - width;
  const maxTx = viewportW * 0.5 - layout.left;
  const minTy = viewportH * 0.5 - layout.top - height;
  const maxTy = viewportH * 0.5 - layout.top;
  return {
    scale: view.scale,
    tx: clamp(view.tx, minTx, maxTx),
    ty: clamp(view.ty, minTy, maxTy),
  };
}

export function toCss(view: ViewTransform): string {
  return `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
