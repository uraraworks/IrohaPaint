// バケツ塗り(ぬりつぶし)。ImageData の生バッファに対して働く純関数なので
// ブラウザ非依存で、vitest からそのまま検証できる。
//
// 走査線(scanline)方式。1748x1181 = 約 206 万画素を 1 タップで塗るため、
// 1 画素ずつスタックに積む素朴な実装だと iPad で目に見えて詰まる。

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 塗り替えた領域の外接矩形。何も塗らなかった場合は null。 */
export interface FillResult {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readPixel(data: Uint8ClampedArray, offset: number): Rgba {
  return {
    r: data[offset] ?? 0,
    g: data[offset + 1] ?? 0,
    b: data[offset + 2] ?? 0,
    a: data[offset + 3] ?? 0,
  };
}

/**
 * 色の近さ。子どもの絵はアンチエイリアスで境界がぼけるため、完全一致だと
 * 線の内側に細い塗り残しが出る。許容差(tolerance)を持たせて吸収する。
 */
function isClose(a: Rgba, b: Rgba, tolerance: number): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance &&
    Math.abs(a.a - b.a) <= tolerance
  );
}

export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  color: Rgba,
  tolerance = 24,
): FillResult | null {
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return null;

  const target = readPixel(data, (startY * width + startX) * 4);
  // 既に同じ色なら何もしない。ここを弾かないと無限に塗り直して固まる。
  if (isClose(target, color, 0)) return null;

  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  // [x, y] を積む。走査線単位で処理するので積まれる点数は画素数よりずっと少ない。
  const stack: number[] = [startX, startY];

  const matches = (x: number, y: number): boolean =>
    isClose(readPixel(data, (y * width + x) * 4), target, tolerance);

  const paint = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    data[offset] = color.r;
    data[offset + 1] = color.g;
    data[offset + 2] = color.b;
    data[offset + 3] = color.a;
  };

  while (stack.length > 0) {
    const y = stack.pop() as number;
    const seedX = stack.pop() as number;
    if (!matches(seedX, y)) continue;

    let left = seedX;
    while (left > 0 && matches(left - 1, y)) left -= 1;
    let right = seedX;
    while (right < width - 1 && matches(right + 1, y)) right += 1;

    for (let x = left; x <= right; x += 1) paint(x, y);

    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    // 上下の行のうち「未処理かつ対象色」の区間の先頭だけを積む。
    for (const nextY of [y - 1, y + 1]) {
      if (nextY < 0 || nextY >= height) continue;
      let inSpan = false;
      for (let x = left; x <= right; x += 1) {
        const ok = matches(x, nextY);
        if (ok && !inSpan) {
          stack.push(x, nextY);
          inSpan = true;
        } else if (!ok) {
          inSpan = false;
        }
      }
    }
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
