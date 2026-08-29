// 「もどる」の実体。
//
// キャンバスは 1748x1181 なので全面スナップショットは 1 枚 8MB 強。
// 素直に積むと数回で iPad のメモリを食い潰すため、*変化した矩形だけ* を
// 変更前の状態で保存する(パッチ方式)。1 本の線なら数十 KB で済む。
// 合計バイト数に上限を設け、超えたら古い方から捨てる。

export interface UndoPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  /** その矩形の *変更前* の画素。 */
  before: ImageData;
}

/** 目安 48MB。これを超えたら古い履歴から落とす。 */
export const DEFAULT_BYTE_BUDGET = 48 * 1024 * 1024;
export const MAX_STEPS = 40;

export function patchBytes(patch: UndoPatch): number {
  return patch.width * patch.height * 4;
}

/**
 * 上限(件数・バイト数)に収まるまで古い側から捨てる。
 * 1 件しか無い場合はバイト数超過でも残す(直前の 1 回は必ず戻せる)。
 */
export function trimPatches(
  patches: readonly UndoPatch[],
  byteBudget = DEFAULT_BYTE_BUDGET,
  maxSteps = MAX_STEPS,
): UndoPatch[] {
  const result = [...patches];
  while (result.length > maxSteps) result.shift();
  let total = result.reduce((sum, patch) => sum + patchBytes(patch), 0);
  while (result.length > 1 && total > byteBudget) {
    const dropped = result.shift();
    if (dropped === undefined) break;
    total -= patchBytes(dropped);
  }
  return result;
}

/** 変更範囲を表す矩形。ストローク中に少しずつ広げていく。 */
export class DirtyRect {
  private minX = Number.POSITIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;

  add(x: number, y: number, radius: number): void {
    if (x - radius < this.minX) this.minX = x - radius;
    if (y - radius < this.minY) this.minY = y - radius;
    if (x + radius > this.maxX) this.maxX = x + radius;
    if (y + radius > this.maxY) this.maxY = y + radius;
  }

  /** キャンバス内に丸めた整数矩形。範囲外や空なら null。 */
  toRect(canvasWidth: number, canvasHeight: number): FillRect | null {
    if (this.maxX < this.minX) return null;
    const x = Math.max(0, Math.floor(this.minX));
    const y = Math.max(0, Math.floor(this.minY));
    const right = Math.min(canvasWidth, Math.ceil(this.maxX) + 1);
    const bottom = Math.min(canvasHeight, Math.ceil(this.maxY) + 1);
    if (right <= x || bottom <= y) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
}

export interface FillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
