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

/**
 * 塗りつぶし。
 *
 * expand は塗った範囲を外へ何 px 広げるか。線はアンチエイリアスで境界がぼけるため、
 * 色一致だけで止めると線の内側に白い輪が残る(子どもの絵で必ず目につく)。
 * 少しだけ線の下へ潜り込ませて消す。線の太さは最小でも 10px なので、
 * 2px 程度の食い込みでは反対側へ漏れない。
 */
export function floodFill(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  color: Rgba,
  tolerance = 24,
  expand = 2,
): FillResult | null {
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return null;

  const target = readPixel(data, (startY * width + startX) * 4);
  // 既に同じ色なら何もしない。ここを弾かないと無限に塗り直して固まる。
  if (isClose(target, color, 0)) return null;

  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;

  // 塗る画素の印。あとで外側へ広げるため、直接塗らずに一旦ここへ溜める。
  const mask = new Uint8Array(width * height);

  // [x, y] を積む。走査線単位で処理するので積まれる点数は画素数よりずっと少ない。
  const stack: number[] = [startX, startY];

  const matches = (x: number, y: number): boolean =>
    isClose(readPixel(data, (y * width + x) * 4), target, tolerance);

  const mark = (x: number, y: number): void => {
    mask[y * width + x] = 1;
  };

  while (stack.length > 0) {
    const y = stack.pop() as number;
    const seedX = stack.pop() as number;
    if (mask[y * width + seedX] === 1 || !matches(seedX, y)) continue;

    let left = seedX;
    while (left > 0 && matches(left - 1, y)) left -= 1;
    let right = seedX;
    while (right < width - 1 && matches(right + 1, y)) right += 1;

    for (let x = left; x <= right; x += 1) mark(x, y);

    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    // 上下の行のうち「未処理かつ対象色」の区間の先頭だけを積む。
    for (const nextY of [y - 1, y + 1]) {
      if (nextY < 0 || nextY >= height) continue;
      let inSpan = false;
      for (let x = left; x <= right; x += 1) {
        const ok = matches(x, nextY) && mask[nextY * width + x] === 0;
        if (ok && !inSpan) {
          stack.push(x, nextY);
          inSpan = true;
        } else if (!ok) {
          inSpan = false;
        }
      }
    }
  }

  // 外へ広げる(アンチエイリアスの縁を線の下へ潜って消す)。
  for (let step = 0; step < expand; step += 1) {
    const grown: number[] = [];
    for (let y = Math.max(0, minY - 1); y <= Math.min(height - 1, maxY + 1); y += 1) {
      for (let x = Math.max(0, minX - 1); x <= Math.min(width - 1, maxX + 1); x += 1) {
        const index = y * width + x;
        if (mask[index] === 1) continue;
        const up = y > 0 && mask[index - width] === 1;
        const down = y < height - 1 && mask[index + width] === 1;
        const leftOn = x > 0 && mask[index - 1] === 1;
        const rightOn = x < width - 1 && mask[index + 1] === 1;
        if (up || down || leftOn || rightOn) grown.push(index);
      }
    }
    if (grown.length === 0) break;
    for (const index of grown) mask[index] = 1;
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(width - 1, maxX + 1);
    maxY = Math.min(height - 1, maxY + 1);
  }

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (mask[y * width + x] === 0) continue;
      const offset = (y * width + x) * 4;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = color.a;
    }
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
