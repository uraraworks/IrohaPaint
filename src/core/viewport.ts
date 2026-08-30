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
 *
 * 元は「等倍(scale=1)なら常に元の位置へ吸着させる」という特別扱いだけだった
 * (子どもが紙を見失わないための保険で、タブレット/PCでは紙が常に画面に収まる前提)。
 * スマホでは紙が画面より大きいままでよく、その状態でも動かせる必要が出てきたため、
 * 軸ごとの規則へ一般化した:
 *   - その軸で紙が画面より小さい → 中央に固定(動かせない。今までの等倍centeredと同じ結果)
 *   - その軸で紙が画面より大きい → 画面の外に隙間ができない範囲(紙の端が画面の端の
 *     内側へ来ない範囲)で動かせる
 * これによりタブレット(紙が画面に収まる)は今までと同じ挙動のまま、スマホ(紙が画面より
 * 大きい)は同じ式で動かせるようになる。
 *
 * layout / viewport はどちらも変換前(scale=1)の矩形。画面上の紙の左端は
 * layout.left + tx、右端は layout.left + tx + layout.width * scale になる(縦も同様)。
 */
export function clampView(view: ViewTransform, layout: Rect, viewport: Rect): ViewTransform {
  return {
    scale: view.scale,
    tx: clampAxis(view.tx, layout.left, layout.width * view.scale, viewport.left, viewport.width),
    ty: clampAxis(view.ty, layout.top, layout.height * view.scale, viewport.top, viewport.height),
  };
}

/** clampView の1軸分。tx/ty どちらにも使えるよう左右(上下)を汎用の start/size で扱う。 */
function clampAxis(
  t: number,
  layoutStart: number,
  size: number,
  viewportStart: number,
  viewportSize: number,
): number {
  if (size <= viewportSize) {
    // 紙(この軸)は画面に収まる → 中央固定。
    return viewportStart + viewportSize / 2 - layoutStart - size / 2;
  }
  // 紙(この軸)は画面より大きい → 端が画面の端の内側へ来ない範囲(隙間ができない範囲)で動かせる。
  const minT = viewportStart + viewportSize - layoutStart - size;
  const maxT = viewportStart - layoutStart;
  return clamp(t, minT, maxT);
}

/** 紙全体に対する「いま画面(viewport)に見えている範囲」。0..1 の割合(x,y,w,h)で表す。 */
export interface VisibleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 全体図(ミニマップ)用。紙のどこが画面に見えているかを、紙全体を 1 として割合で返す。
 * layout / viewport は clampView と同じく変換前(scale=1)の矩形。
 *
 * 紙は clampView によって画面の外へ隙間なく飛び出す位置には来ない前提だが、
 * 呼び出し側の丸め誤差等で多少はみ出しても 0..1 に収まるようクランプする。
 */
export function visibleRect(view: ViewTransform, layout: Rect, viewport: Rect): VisibleRect {
  const paperLeft = layout.left + view.tx;
  const paperTop = layout.top + view.ty;
  const paperWidth = layout.width * view.scale;
  const paperHeight = layout.height * view.scale;

  if (paperWidth <= 0 || paperHeight <= 0) return { x: 0, y: 0, w: 1, h: 1 };

  const visLeft = clamp(viewport.left, paperLeft, paperLeft + paperWidth);
  const visRight = clamp(viewport.left + viewport.width, paperLeft, paperLeft + paperWidth);
  const visTop = clamp(viewport.top, paperTop, paperTop + paperHeight);
  const visBottom = clamp(viewport.top + viewport.height, paperTop, paperTop + paperHeight);

  const x = clamp((visLeft - paperLeft) / paperWidth, 0, 1);
  const y = clamp((visTop - paperTop) / paperHeight, 0, 1);
  const w = clamp((visRight - visLeft) / paperWidth, 0, 1 - x);
  const h = clamp((visBottom - visTop) / paperHeight, 0, 1 - y);

  return { x, y, w, h };
}

/** 紙が(誤差程度を除いて)画面に全部見えているか。全体図を出す必要が無い状態。 */
export function isFullyVisible(rect: VisibleRect): boolean {
  const EPS = 1e-3;
  return rect.x <= EPS && rect.y <= EPS && rect.w >= 1 - EPS && rect.h >= 1 - EPS;
}

export function toCss(view: ViewTransform): string {
  return `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
