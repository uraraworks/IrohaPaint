// 「しかく」「まる」で塗るときの形の計算。
//
// 色の境界をたどる塗りつぶし(floodFill.ts)は、大人には当たり前でも
// 子どもには何が起きるか想像できない — 「線で囲んでから押す」という前提が
// 見えないからで、ビーズを並べた上では特にそう(マスの隙間が境界になる)。
// そこで **自分で範囲を決めて塗る** 形を用意する。指でなぞった四角がそのまま
// 塗られるので、バケツをこぼす感覚のまま使える。
//
// ここは Canvas に触らない純粋な計算だけを置く(vitest からそのまま検証できる)。

/** 塗り方。area = 色の境界まで / rect = しかく / circle = まる。 */
export type FillMode = "area" | "rect" | "circle";

/** 自分で範囲を決めて塗る方(area 以外)。 */
export type ShapeMode = Exclude<FillMode, "area">;

export interface ShapeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CellRef {
  col: number;
  row: number;
}

export function isShapeMode(mode: FillMode): mode is ShapeMode {
  return mode !== "area";
}

/**
 * ドラッグの 2 点から、キャンバスに収まる整数の外接矩形を作る。
 *
 * min は最小の一辺。**押しただけ(ドラッグ 0px)でも必ず何かが出る**ようにするための下限で、
 * ここを 0 にすると「押したのに何も起きない」= 子どもから見れば壊れている、になる。
 * 下限を足す向きは「指を置いた側から外へ」ではなく中心から均等に広げる
 * (指の下に出る方が、押した場所と結果が結びつく)。
 */
export function shapeBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  canvasWidth: number,
  canvasHeight: number,
  min = 8,
): ShapeBox {
  let left = Math.min(x0, x1);
  let right = Math.max(x0, x1);
  let top = Math.min(y0, y1);
  let bottom = Math.max(y0, y1);

  if (right - left < min) {
    const center = (left + right) / 2;
    left = center - min / 2;
    right = center + min / 2;
  }
  if (bottom - top < min) {
    const center = (top + bottom) / 2;
    top = center - min / 2;
    bottom = center + min / 2;
  }

  const ix = Math.max(0, Math.floor(left));
  const iy = Math.max(0, Math.floor(top));
  const ir = Math.min(canvasWidth, Math.ceil(right));
  const ib = Math.min(canvasHeight, Math.ceil(bottom));
  return { x: ix, y: iy, width: Math.max(0, ir - ix), height: Math.max(0, ib - iy) };
}

/** 矩形に内接する楕円の内側か。「まる」はドラッグした枠いっぱいに膨らむ。 */
export function ellipseContains(box: ShapeBox, x: number, y: number): boolean {
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (x - (box.x + rx)) / rx;
  const dy = (y - (box.y + ry)) / ry;
  return dx * dx + dy * dy <= 1;
}

/**
 * ビーズモードで塗るマスの一覧。
 *
 * ビーズは 1 マス = 1 個なので、形も **マス単位** に丸める。中途半端に欠けた
 * ビーズが出ると図案として数えられなくなる(実際に作れない図案になる)。
 * まるは「マスの中心が楕円の内側にあるか」で判定する。
 */
export function shapeCells(
  mode: ShapeMode,
  box: ShapeBox,
  cellWidth: number,
  cellHeight: number,
  cols: number,
  rows: number,
): CellRef[] {
  if (box.width <= 0 || box.height <= 0) return [];
  const clampCol = (value: number): number => Math.min(cols - 1, Math.max(0, value));
  const clampRow = (value: number): number => Math.min(rows - 1, Math.max(0, value));
  // 中心が枠の外でも、枠に重なるマスは必ず 1 つは拾う(細いドラッグでも空振りしない)。
  const minCol = clampCol(Math.floor(box.x / cellWidth));
  const maxCol = clampCol(Math.floor((box.x + box.width - 1) / cellWidth));
  const minRow = clampRow(Math.floor(box.y / cellHeight));
  const maxRow = clampRow(Math.floor((box.y + box.height - 1) / cellHeight));

  const cells: CellRef[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      if (mode === "circle") {
        const cx = (col + 0.5) * cellWidth;
        const cy = (row + 0.5) * cellHeight;
        // 1 マスしか無いときは中心判定を課さない(押しただけでも 1 個は置ける)。
        const only = minCol === maxCol && minRow === maxRow;
        if (!only && !ellipseContains(box, cx, cy)) continue;
      }
      cells.push({ col, row });
    }
  }
  return cells;
}

/** マスの一覧を包む矩形(塗り替えた範囲として履歴に渡す)。空なら null。 */
export function cellsBounds(
  cells: readonly CellRef[],
  cellWidth: number,
  cellHeight: number,
): ShapeBox | null {
  if (cells.length === 0) return null;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const cell of cells) {
    if (cell.col < minCol) minCol = cell.col;
    if (cell.col > maxCol) maxCol = cell.col;
    if (cell.row < minRow) minRow = cell.row;
    if (cell.row > maxRow) maxRow = cell.row;
  }
  const left = Math.floor(minCol * cellWidth);
  const top = Math.floor(minRow * cellHeight);
  return {
    x: left,
    y: top,
    width: Math.ceil((maxCol + 1) * cellWidth) - left,
    height: Math.ceil((maxRow + 1) * cellHeight) - top,
  };
}
