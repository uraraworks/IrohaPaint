// 描画面。Canvas 2D を 1 枚だけ持つ(Phase 0 はレイヤー無し)。
// 「もどる」はパッチ方式(undoStack.ts 参照)。
import { CANVAS_HEIGHT, CANVAS_WIDTH, createId, type CellGrid } from "./model.ts";
import { floodFill, type Rgba } from "./floodFill.ts";
import { cellsBounds, shapeBox, shapeCells, type ShapeMode } from "./fillShape.ts";
import { DirtyRect, MAX_STEPS, trimPatches, type FillRect, type UndoPatch } from "./undoStack.ts";
import { NIB_DEFS, shiftColor, strokeWidth, type NibDynamics } from "./brush.ts";

export const PAPER_COLOR = "#fffdf7";

/**
 * これ以上増やすと自分でも分からなくなるので、UI 側で「もう十分だよ」と一声かける目安。
 * 強制はしない(上限で弾くと「なぜ増えないのか」が子どもには分からない)。
 */
export const SOFT_LAYER_LIMIT = 8;

export interface StrokeStyle {
  color: string;
  /** キャンバス座標での基準の太さ(px)。ペン先によってはここから増減する。 */
  size: number;
  /** 消しゴムは紙の色で塗るのではなく合成モードで消す。 */
  erase: boolean;
  /** ペン先の性質(速さ→太さ・入り抜き・手ブレ補正)。省略時はクレヨン(太さ一定)。 */
  dynamics?: NibDynamics;
  /**
   * アイロンビーズ / ドット絵モードの格子。指定するとマス単位でしか置けなくなる。
   * 太さもペン先も効かない(1 マス = 1 個なので、そもそも太さの概念が無い)。
   * 省略 / undefined で従来どおりの自由な線。
   */
  cells?: CellGrid;
}

/**
 * マスの色を見るための位置。
 *
 * ビーズは真ん中に穴が空いているので **中心を見てはいけない**。
 * 穴＝透明なので、置いてあるのに「何も無い」と判定してしまう
 * (塗りつぶしが全面へ漏れる / スポイトが紙の色を吸う、という形で実際に出た)。
 * そこで中心から少しずらした 4 点を見る。
 * ドット絵は四角のベタ塗りで穴が無いので、中心 1 点で足りる。
 */
export function cellProbePoints(grid: CellGrid, col: number, row: number): [number, number][] {
  const cx = (col + 0.5) * grid.cellWidth;
  const cy = (row + 0.5) * grid.cellHeight;
  if (!grid.round) return [[cx, cy]];
  const ring = Math.min(grid.cellWidth, grid.cellHeight) * 0.3;
  return [
    [cx + ring, cy],
    [cx - ring, cy],
    [cx, cy + ring],
    [cx, cy - ring],
  ];
}

/** 座標をマス番号へ。範囲外は端に丸める。 */
export function cellOf(grid: CellGrid, x: number, y: number): { col: number; row: number } {
  return {
    col: Math.min(grid.cols - 1, Math.max(0, Math.floor(x / grid.cellWidth))),
    row: Math.min(grid.rows - 1, Math.max(0, Math.floor(y / grid.cellHeight))),
  };
}

/** 1 本ぶんの描画状態。指(pointerId)ごとに独立して持つ。 */
interface StrokeState {
  style: StrokeStyle;
  dynamics: NibDynamics;
  dirty: DirtyRect;
  /** 手ブレ補正後の現在位置。 */
  smoothX: number;
  smoothY: number;
  lastTime: number;
  /** 直前に実際に描いた点。 */
  lastX: number;
  lastY: number;
  lastWidth: number;
  travelled: number;
  pending: PendingPoint[];
  drewAnything: boolean;
  /** ビーズモードで、この 1 ストロークに既に置いたマス(同じマスを塗り直さない)。 */
  placedCells: Set<number>;
  /**
   * 油絵の「筆の毛」。1 本ごとの位置と濃さを **ストロークの最初に決めて固定する**。
   * 区間ごとに乱数を振り直すと筋が繋がらず、格子状の模様になってしまう。
   */
  bristles: Bristle[];
  /** 仮インクを描いた範囲(消すときに使う)。 */
  overlayDirty: FillRect | null;
}

/** 油絵の筆の毛 1 本。 */
interface Bristle {
  /** 線の中心からの位置(-1..1)。 */
  offset: number;
  /** 色の明暗(-1..1)。 */
  shade: number;
  alpha: number;
}

/** 描画待ちの点。入り抜きのために、線の末尾は少しだけ描かずに保持する。 */
interface PendingPoint {
  x: number;
  y: number;
  speed: number;
  pressure: number | undefined;
  /** 線の始点からの道のり(px)。 */
  distance: number;
}

/**
 * レイヤー 1 枚ぶんの置き場。
 *
 * JS で毎フレーム合成するのではなく、レイヤーごとに canvas 要素を DOM に重ねて
 * ブラウザに合成させる(描画のホットパスを一切触らずに済むのが理由)。
 * `this.canvas`(= .paper)は常に「いま選んでいるレイヤー」の描画先そのものなので、
 * アクティブなスロットの canvas/ctx は切り替えるまで出番が無い(中身も古いまま)。
 */
interface LayerSlot {
  id: string;
  /** そのレイヤーの画素の置き場。アクティブな 1 枚のぶんは this.canvas 側にあり、
      こちらは切り替えるまで古いままになる(display:none で画面にも出さない)。 */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  opacity: number;
  /** そのレイヤーの「もどる」履歴。アクティブな 1 枚のぶんは this.patches 側にある。 */
  patches: UndoPatch[];
  redoPatches: UndoPatch[];
}

export class Surface {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * 1 手前の状態を丸ごと保持する控え。
   * undo をパッチ方式にすると「変更前の画素」が要るが、変更範囲は描き終わるまで
   * 確定しない(線がどこまで伸びるか分からない)。毎回ストローク前に全面を控えると
   * 8MB/回で破綻するので、常に 1 手前を映した控えを 1 枚だけ持ち、
   * 描き終わってから *その矩形だけ* を控えから拾う。
   */
  private readonly backup: HTMLCanvasElement;
  private readonly backupCtx: CanvasRenderingContext2D;
  /**
   * 描いている最中の「まだ確定していない末尾」を映す層。
   *
   * 入り抜きのある線は、描き終わりが分かるまで末尾を確定できない。
   * かといって確定するまで何も出さないと、線が指から遅れてついてくる。
   * そこで末尾はこの層に即座に描いておき(仮のインク)、指を離した時点で
   * 本番(細らせたもの)をキャンバスへ描いて、この層は消す。
   */
  readonly overlay: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private patches: UndoPatch[] = [];
  /** 「戻る」で巻き戻した分。新しく描いたら捨てる(一般的なペイントと同じ作法)。 */
  private redoPatches: UndoPatch[] = [];
  /** 描いている最中の線。pointerId をキーにするので、何人が同時に描いても混ざらない。 */
  private readonly strokes = new Map<number, StrokeState>();
  /**
   * 「しかく」「まる」で塗る途中の下見を描いた範囲。
   * 指を動かすたびに前の下見を消して描き直すので、消す範囲を覚えておく。
   */
  private shapePreviewDirty: FillRect | null = null;

  /**
   * レイヤーの一覧。index 0 が一番下。
   * アクティブなスロット(= activeIndex)の画素は this.canvas 側にあり、
   * スロット自身の canvas は切り替えるまで古いまま(display:none)。
   */
  private layers: LayerSlot[] = [];
  private activeIndex = 0;
  /**
   * drawLayerThumbnail() の段階縮小で使い回す作業用キャンバス2枚(ピンポンで交互に使う)。
   * 呼ぶたびに新規生成すると帯を開くたびにレイヤー枚数分アロケーションが走るため、
   * 使い回して確保コストを消す。
   */
  private thumbnailScratch: [HTMLCanvasElement, HTMLCanvasElement] | null = null;

  /** この Surface が扱うキャンバスの画素寸法。作品ごとに違いうるので固定定数にしない。 */
  readonly width: number;
  readonly height: number;

  constructor(canvas: HTMLCanvasElement, width: number = CANVAS_WIDTH, height: number = CANVAS_HEIGHT) {
    this.width = width;
    this.height = height;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.canvas = canvas;
    this.ctx = ctx;
    const backup = document.createElement("canvas");
    backup.width = width;
    backup.height = height;
    const backupCtx = backup.getContext("2d", { willReadFrequently: true });
    if (backupCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.backup = backup;
    this.backupCtx = backupCtx;
    const overlay = document.createElement("canvas");
    overlay.width = width;
    overlay.height = height;
    overlay.className = "paper-overlay";
    const overlayCtx = overlay.getContext("2d");
    if (overlayCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.overlay = overlay;
    this.overlayCtx = overlayCtx;
    this.clearToPaper();
    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });

    // レイヤーは 1 枚から始める。控え canvas は .paper の兄弟として .paper-wrap に
    // 挿しておく(切り替えるまで中身は使わないので display:none)。
    // 親がまだ無い(canvas がまだ DOM に挿さっていない)呼び出し元もありうるので、
    // その場合は挿さずに保持だけする。
    const first = this.createLayerSlot();
    first.canvas.style.display = "none";
    const parent = this.canvas.parentElement;
    if (parent !== null) parent.appendChild(first.canvas);
    this.layers = [first];
    this.activeIndex = 0;
  }

  /** 空のレイヤースロットを 1 つ作る(canvas 生成込み)。DOM への挿入は呼び出し側の仕事。 */
  private createLayerSlot(): LayerSlot {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.className = "paper-layer";
    // いま dot モード中に増やしたレイヤーは、最初からドット絵の見た目に揃える。
    // ここで合わせておかないと、restack() で表に出た瞬間だけ補間がかかって角が
    // ぼやけ、他のレイヤーと見た目が食い違う。
    if (this.canvas.classList.contains("is-pixelated")) canvas.classList.add("is-pixelated");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    return {
      id: createId("layer"),
      canvas,
      ctx,
      visible: true,
      opacity: 1,
      patches: [],
      redoPatches: [],
    };
  }

  get canUndo(): boolean {
    return this.patches.length > 0;
  }

  get canRedo(): boolean {
    return this.redoPatches.length > 0;
  }

  clearToPaper(): void {
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.fillStyle = PAPER_COLOR;
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  // --- ストローク -------------------------------------------------------
  //
  // 同時に何本も描ける(「みんなで描く」モード)。1 本ごとの状態は StrokeState に閉じ込め、
  // pointerId をキーに持つ。1 人で使うときも同じ経路を通る(本数が 1 本なだけ)。

  beginStroke(
    id: number,
    x: number,
    y: number,
    style: StrokeStyle,
    time = 0,
    pressure?: number,
  ): void {
    this.revealActiveLayerIfHidden();
    const dynamics = style.dynamics ?? NIB_DEFS.crayon.dynamics;
    const dirty = new DirtyRect();
    dirty.add(x, y, style.size * dynamics.maxWidthRatio);
    this.strokes.set(id, {
      style,
      dynamics,
      dirty,
      smoothX: x,
      smoothY: y,
      lastTime: time,
      lastX: x,
      lastY: y,
      lastWidth: style.size,
      travelled: 0,
      drewAnything: false,
      overlayDirty: null,
      placedCells: new Set<number>(),
      bristles: dynamics.texture === "oil" ? createBristles() : [],
      // 入り抜きのある先端は、描き終わりが分かるまで描けない。
      // 末尾を少しだけ保持しておき、endStroke でまとめて細らせながら描く。
      pending: [{ x, y, speed: 0, pressure, distance: 0 }],
    });
    if (style.cells !== undefined) {
      const stroke = this.strokes.get(id);
      if (stroke !== undefined) this.placeCell(stroke, x, y);
    }
  }

  /** マス目に 1 つ置く。同じマスは 1 ストロークにつき 1 回だけ塗る。 */
  private placeCell(stroke: StrokeState, x: number, y: number): void {
    const grid = stroke.style.cells;
    if (grid === undefined) return;
    const { col, row } = cellOf(grid, x, y);
    const key = row * grid.cols + col;
    if (stroke.placedCells.has(key)) return;
    stroke.placedCells.add(key);
    this.paintCell(grid, col, row, stroke.style.erase ? null : stroke.style.color);
    stroke.drewAnything = true;
    stroke.dirty.add(col * grid.cellWidth, row * grid.cellHeight, 0);
    stroke.dirty.add((col + 1) * grid.cellWidth, (row + 1) * grid.cellHeight, 0);
  }

  /**
   * マス 1 つを塗る。color=null で消す。
   *
   * ビーズは実物に合わせて **穴あきの円**。四角で埋めるより出来上がりの見た目に近く、
   * 図案としても数えやすい。
   * ドット絵は **マスいっぱいの四角**。隣のマスと隙間なく繋がることが要件なので、
   * 境界は外側へ丸めて塗る(内側へ丸めると 1px の筋が残り、拡大したときに目立つ)。
   */
  private paintCell(
    grid: CellGrid,
    col: number,
    row: number,
    color: string | null,
    ctx: CanvasRenderingContext2D = this.ctx,
  ): void {
    // マスの境界は実数なので、消すときは外側へ丸めて隣に残りかすを作らない。
    const left = Math.floor(col * grid.cellWidth);
    const top = Math.floor(row * grid.cellHeight);
    const right = Math.ceil((col + 1) * grid.cellWidth);
    const bottom = Math.ceil((row + 1) * grid.cellHeight);

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(left, top, right - left, bottom - top);
    if (color !== null) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = color;
      if (grid.round) {
        const cx = (col + 0.5) * grid.cellWidth;
        const cy = (row + 0.5) * grid.cellHeight;
        const outer = Math.min(grid.cellWidth, grid.cellHeight) * 0.46;
        ctx.beginPath();
        ctx.arc(cx, cy, outer, 0, Math.PI * 2);
        ctx.fill();
        // 真ん中の穴。アイロンをかけると溶けて縮むので、小さめにして仕上がりに寄せる。
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(cx, cy, outer * 0.17, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(left, top, right - left, bottom - top);
      }
    }
    ctx.restore();
  }

  /**
   * マス目モードの塗りつぶし。**マス単位**で広がる。
   * 円で置くと隙間ができるので、画素をたどる塗りつぶしでは背景ごと漏れてしまう。
   * マスの色を見て、同じ色のマスへ伝播させる。
   */
  fillCells(grid: CellGrid, x: number, y: number, color: string): FillRect | null {
    this.revealActiveLayerIfHidden();
    const image = this.ctx.getImageData(0, 0, this.width, this.height);
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    /** そのマスに置かれているビーズの色。空なら "empty"。 */
    const colorAt = (col: number, row: number): string => {
      for (const [px, py] of cellProbePoints(grid, col, row)) {
        const ix = Math.min(this.width - 1, Math.max(0, Math.floor(px)));
        const iy = Math.min(this.height - 1, Math.max(0, Math.floor(py)));
        const offset = (iy * this.width + ix) * 4;
        if ((image.data[offset + 3] ?? 0) < 8) continue;
        return `#${hex(image.data[offset] ?? 0)}${hex(image.data[offset + 1] ?? 0)}${hex(image.data[offset + 2] ?? 0)}`;
      }
      return "empty";
    };

    const start = cellOf(grid, x, y);
    const target = colorAt(start.col, start.row);
    if (target === color.toLowerCase()) return null;

    const seen = new Uint8Array(grid.cols * grid.rows);
    const stack = [start];
    let minCol = start.col;
    let maxCol = start.col;
    let minRow = start.row;
    let maxRow = start.row;
    while (stack.length > 0) {
      const cell = stack.pop() as { col: number; row: number };
      if (cell.col < 0 || cell.row < 0 || cell.col >= grid.cols || cell.row >= grid.rows) continue;
      const key = cell.row * grid.cols + cell.col;
      if (seen[key] === 1) continue;
      if (colorAt(cell.col, cell.row) !== target) continue;
      seen[key] = 1;
      this.paintCell(grid, cell.col, cell.row, color);
      if (cell.col < minCol) minCol = cell.col;
      if (cell.col > maxCol) maxCol = cell.col;
      if (cell.row < minRow) minRow = cell.row;
      if (cell.row > maxRow) maxRow = cell.row;
      stack.push(
        { col: cell.col - 1, row: cell.row },
        { col: cell.col + 1, row: cell.row },
        { col: cell.col, row: cell.row - 1 },
        { col: cell.col, row: cell.row + 1 },
      );
    }

    const left = Math.floor(minCol * grid.cellWidth);
    const top = Math.floor(minRow * grid.cellHeight);
    return {
      x: left,
      y: top,
      width: Math.ceil((maxCol + 1) * grid.cellWidth) - left,
      height: Math.ceil((maxRow + 1) * grid.cellHeight) - top,
    };
  }

  extendStroke(id: number, x: number, y: number, time = 0, pressure?: number): void {
    const stroke = this.strokes.get(id);
    if (stroke === undefined) return;

    const cellGrid = stroke.style.cells;
    if (cellGrid !== undefined) {
      // 速く動かすとイベントが飛ぶので、前の点との間を補間して通過したマスを埋める。
      // 手ブレ補正も速さによる太さも要らない(マスに吸着するので意味を持たない)。
      const steps = Math.ceil(
        Math.max(
          Math.abs(x - stroke.lastX) / cellGrid.cellWidth,
          Math.abs(y - stroke.lastY) / cellGrid.cellHeight,
        ),
      );
      for (let i = 1; i <= Math.max(1, steps); i += 1) {
        const t = i / Math.max(1, steps);
        this.placeCell(stroke, stroke.lastX + (x - stroke.lastX) * t, stroke.lastY + (y - stroke.lastY) * t);
      }
      stroke.lastX = x;
      stroke.lastY = y;
      return;
    }

    // 手ブレ補正。指の細かい揺れを吸収する。数フレームぶん遅れるが、
    // 線の見た目が落ち着く効果の方がはるかに大きい。
    const alpha = 1 - stroke.dynamics.smoothing;
    const prevX = stroke.smoothX;
    const prevY = stroke.smoothY;
    stroke.smoothX += (x - stroke.smoothX) * alpha;
    stroke.smoothY += (y - stroke.smoothY) * alpha;

    const step = Math.hypot(stroke.smoothX - prevX, stroke.smoothY - prevY);
    if (step < 0.01) return;
    // 端末やイベントの詰まりで dt が壊れても速さが暴れないよう範囲を絞る。
    const dt = Math.min(100, Math.max(1, time - stroke.lastTime));
    stroke.lastTime = time;
    stroke.travelled += step;
    stroke.pending.push({
      x: stroke.smoothX,
      y: stroke.smoothY,
      speed: step / dt,
      pressure,
      distance: stroke.travelled,
    });
    stroke.dirty.add(stroke.smoothX, stroke.smoothY, stroke.style.size * stroke.dynamics.maxWidthRatio);

    // 末尾(抜きに使う長さ)より古い点は、もう細らせる必要がないので確定して描く。
    while (stroke.pending.length > 1) {
      const head = stroke.pending[0] as PendingPoint;
      if (stroke.travelled - head.distance <= stroke.dynamics.taperOutPx) break;
      stroke.pending.shift();
      this.renderPoint(stroke, head, Number.POSITIVE_INFINITY);
    }
    this.drawWetInk(stroke);
  }

  /** 描きかけを無かったことにする(ピンチに移った時)。id 省略で全部。 */
  cancelStroke(id?: number): void {
    const targets = id === undefined ? [...this.strokes.keys()] : [id];
    for (const key of targets) {
      const stroke = this.strokes.get(key);
      if (stroke === undefined) continue;
      this.clearWetInk(stroke);
      this.strokes.delete(key);
      const rect = stroke.dirty.toRect(this.width, this.height);
      if (rect === null) continue;
      // 控え(1 手前の状態)から描き戻すので、undo 履歴は消費しない。
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
      this.ctx.drawImage(
        this.backup,
        rect.x, rect.y, rect.width, rect.height,
        rect.x, rect.y, rect.width, rect.height,
      );
    }
  }

  /** ストロークを確定する。戻り値は変更矩形。 */
  endStroke(id: number, rawX?: number, rawY?: number): FillRect | null {
    const stroke = this.strokes.get(id);
    if (stroke === undefined) return null;
    this.strokes.delete(id);
    this.clearWetInk(stroke);

    if (stroke.style.cells !== undefined) return stroke.dirty.toRect(this.width, this.height);

    // 手ブレ補正の分だけ描画点は指より後ろにいる。離した位置まで最後に伸ばして
    // 「線が指まで届かない」感じを消す。
    const last = stroke.pending[stroke.pending.length - 1];
    if (rawX !== undefined && rawY !== undefined && last !== undefined) {
      const step = Math.hypot(rawX - last.x, rawY - last.y);
      if (step > 0.5) {
        stroke.travelled += step;
        stroke.pending.push({
          x: rawX,
          y: rawY,
          speed: last.speed,
          pressure: last.pressure,
          distance: stroke.travelled,
        });
        stroke.dirty.add(rawX, rawY, stroke.style.size * stroke.dynamics.maxWidthRatio);
      }
    }

    // 残しておいた末尾を、終端に近づくほど細くしながら描く。
    for (const point of stroke.pending) {
      this.renderPoint(stroke, point, stroke.travelled - point.distance);
    }
    // 「ちょん」と置いただけの点も必ず残す(子どもは点を打つ)。
    if (!stroke.drewAnything) {
      const width = Math.max(2, stroke.style.size * (stroke.style.dynamics === undefined ? 1 : 0.6));
      this.paintDot(stroke.lastX, stroke.lastY, width, stroke.style);
    }
    return stroke.dirty.toRect(this.width, this.height);
  }

  /** 保持中の末尾を仮のインクとして描く。指に線が遅れてついてくるのを防ぐ。 */
  private drawWetInk(stroke: StrokeState): void {
    this.clearWetInk(stroke);
    // 消しゴムは「消えた結果」を重ねて見せられないので仮インクを出さない
    // (太さ一定なので末尾を保持しておらず、そもそも遅れない)。
    if (stroke.style.erase || stroke.pending.length === 0 || stroke.dynamics.taperOutPx <= 0) return;

    const ctx = this.overlayCtx;
    ctx.save();
    ctx.strokeStyle = stroke.style.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let prevX = stroke.lastX;
    let prevY = stroke.lastY;
    let prevWidth = stroke.lastWidth;
    let minX = prevX;
    let minY = prevY;
    let maxX = prevX;
    let maxY = prevY;
    let maxWidth = prevWidth;
    for (const point of stroke.pending) {
      // 抜きはまだ掛けない(掛けると、描いている最中だけ細く見えてしまう)。
      const width = strokeWidth(
        stroke.style.size,
        stroke.dynamics,
        point.speed,
        point.pressure,
        point.distance,
        Number.POSITIVE_INFINITY,
      );
      ctx.lineWidth = Math.max(1, (prevWidth + width) / 2);
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      prevX = point.x;
      prevY = point.y;
      prevWidth = width;
      if (width > maxWidth) maxWidth = width;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    ctx.restore();

    const pad = Math.ceil(maxWidth) + 2;
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    stroke.overlayDirty = {
      x,
      y,
      width: Math.min(this.width, Math.ceil(maxX + pad)) - x,
      height: Math.min(this.height, Math.ceil(maxY + pad)) - y,
    };
  }

  private clearWetInk(stroke: StrokeState): void {
    const rect = stroke.overlayDirty;
    if (rect === null) return;
    this.overlayCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
    stroke.overlayDirty = null;
  }

  /** 1 点ぶんを、直前の点からの線として描く。 */
  private renderPoint(stroke: StrokeState, point: PendingPoint, distanceFromEnd: number): void {
    const width = strokeWidth(
      stroke.style.size,
      stroke.dynamics,
      point.speed,
      point.pressure,
      point.distance,
      distanceFromEnd,
    );
    if (point.x !== stroke.lastX || point.y !== stroke.lastY) {
      // 太さは点ごとに変わるので、区間の平均で描く。区間が短いので段差は見えない。
      this.paintLine(
        stroke.lastX,
        stroke.lastY,
        point.x,
        point.y,
        (stroke.lastWidth + width) / 2,
        stroke.style,
        stroke.dynamics,
        stroke.bristles,
      );
      stroke.drewAnything = true;
    }
    stroke.lastX = point.x;
    stroke.lastY = point.y;
    stroke.lastWidth = width;
  }

  private paintLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    style: StrokeStyle,
    dynamics?: NibDynamics,
    bristles: readonly Bristle[] = [],
  ): void {
    const texture = style.erase ? "smooth" : (dynamics?.texture ?? "smooth");
    if (texture === "pencil") {
      this.paintPencil(x0, y0, x1, y1, width, style);
      return;
    }
    if (texture === "oil") {
      this.paintOil(x0, y0, x1, y1, width, style, bristles);
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = style.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(1, width);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 色鉛筆。薄い粒をばらまく。
   * 1 回で塗り切らないので、同じ場所を重ねるほど濃くなる = 本物と同じ手応えになる。
   * 紙の目に見せるため、粒は線の直交方向にばらつかせる。
   */
  private paintPencil(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    style: StrokeStyle,
  ): void {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(length / 1.6));
    const nx = length === 0 ? 0 : -(y1 - y0) / length;
    const ny = length === 0 ? 0 : (x1 - x0) / length;
    const half = Math.max(1, width) / 2;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = style.color;
    ctx.globalAlpha = 0.16;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      // 1 区間につき数粒。中心ほど密に落ちるよう、ばらつきに乱数を 2 回掛ける。
      for (let k = 0; k < 3; k += 1) {
        const spread = (Math.random() * 2 - 1) * (Math.random() * 0.5 + 0.5) * half;
        const radius = half * (0.18 + Math.random() * 0.22);
        ctx.beginPath();
        ctx.arc(px + nx * spread, py + ny * spread, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * 油絵。何本もの筋を並べて引く。
   * 筆の毛ごとに色を少し明るく / 暗くして、絵の具を盛った筆跡に見せる。
   */
  private paintOil(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    style: StrokeStyle,
    bristles: readonly Bristle[],
  ): void {
    const length = Math.hypot(x1 - x0, y1 - y0);
    const nx = length === 0 ? 0 : -(y1 - y0) / length;
    const ny = length === 0 ? 0 : (x1 - x0) / length;
    const half = Math.max(1, width) / 2;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, (half * 2) / bristles.length) * 1.35;
    for (const bristle of bristles) {
      const offset = bristle.offset * half;
      ctx.strokeStyle = shiftColor(style.color, bristle.shade);
      ctx.globalAlpha = bristle.alpha;
      ctx.beginPath();
      ctx.moveTo(x0 + nx * offset, y0 + ny * offset);
      ctx.lineTo(x1 + nx * offset, y1 + ny * offset);
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintDot(x: number, y: number, width: number, style: StrokeStyle): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = style.erase ? "destination-out" : "source-over";
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, width) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }


  // --- undo -------------------------------------------------------------

  /**
   * 変更を 1 手として確定する。*描き終わったあと* に、変更矩形を渡して呼ぶ。
   * 変更前の画素は控え(backup)から拾い、そのあと控えを現状に合わせる。
   */
  /**
   * 変更を 1 手として確定する。*描き終わったあと* に、変更矩形を渡して呼ぶ。
   *
   * history=false のときは控えを現状に合わせるだけで履歴に積まない。
   * 「みんなで描く」モードは複数人が同時に描くので「戻る」自体を持たない
   * (誰の 1 手を戻すのか決められず、他の子の線が消える事故になる)。
   */
  commit(rect: FillRect, history = true): void {
    if (history) {
      const before = this.backupCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
      this.patches = trimPatches([...this.patches, { ...rect, before }]);
      // 巻き戻した先から描き直したら、その先の未来は無くなる。
      this.redoPatches = [];
    } else {
      this.patches = [];
      this.redoPatches = [];
    }
    this.syncBackup(rect);
  }

  /** 控えの指定矩形を現在のキャンバスで置き換える。消しゴム跡(透明)も含めて写す。 */
  /** 仮インクを全部消す(作品の切り替え・やり直し時)。 */
  private clearOverlay(): void {
    this.overlayCtx.clearRect(0, 0, this.width, this.height);
    for (const stroke of this.strokes.values()) stroke.overlayDirty = null;
    this.shapePreviewDirty = null;
  }

  private syncBackup(rect: FillRect): void {
    this.backupCtx.globalCompositeOperation = "source-over";
    this.backupCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
    this.backupCtx.drawImage(
      this.canvas,
      rect.x, rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height,
    );
  }

  /** 履歴を捨てる(「みんなで描く」モードへ入るとき)。絵はそのまま。 */
  dropHistory(): void {
    this.patches = [];
    this.redoPatches = [];
  }

  undo(): boolean {
    return this.step(this.patches, this.redoPatches);
  }

  redo(): boolean {
    return this.step(this.redoPatches, this.patches);
  }

  /**
   * from の末尾 1 手を適用し、入れ替わりに「適用前の画素」を to へ積む。
   * undo と redo は向きが違うだけの同じ操作なので 1 本にまとめる。
   */
  private step(from: UndoPatch[], to: UndoPatch[]): boolean {
    const patch = from.pop();
    if (patch === undefined) return false;
    // 戻す前の状態を反対側へ預ける。これが redo(または redo の undo)になる。
    const current = this.ctx.getImageData(patch.x, patch.y, patch.width, patch.height);
    to.push({ x: patch.x, y: patch.y, width: patch.width, height: patch.height, before: current });
    while (to.length > MAX_STEPS) to.shift();
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.putImageData(patch.before, patch.x, patch.y);
    // 控えも巻き戻す。ここを忘れると次の 1 手で「戻したはずの絵」が復活する。
    this.backupCtx.putImageData(patch.before, patch.x, patch.y);
    return true;
  }

  /**
   * DOM に挿した自前の要素(仮インク・レイヤーの控え)を全部外す。Surface を作り直すときに呼ぶ。
   *
   * overlay だけ外しても足りない: レイヤーの控え canvas(this.layers の各 canvas)は
   * this.canvas とは別に .paper-wrap へ直接挿さっており(restack() 参照)、overlay を
   * 外しただけでは残り続ける。display:none で見た目には出ないが 1 枚 8MB もあるので、
   * 寸法を変えるたびに古い Surface の分がぶら下がったままメモリに積み上がってしまう。
   */
  detach(): void {
    this.overlay.remove();
    for (const layer of this.layers) layer.canvas.remove();
  }

  /**
   * ドット絵モードの最近傍補間。アクティブな 1 枚だけでなく全レイヤーに掛ける
   * (掛け忘れたレイヤーだけ角がぼやけて見た目が揃わなくなる)。
   */
  setPixelated(on: boolean): void {
    this.canvas.classList.toggle("is-pixelated", on);
    for (const layer of this.layers) layer.canvas.classList.toggle("is-pixelated", on);
  }

  // --- レイヤー -----------------------------------------------------------
  //
  // JS で毎フレーム合成しない代わりに、レイヤーごとの canvas を DOM に重ねて
  // ブラウザに合成させる(下ごしらえは style.css の .paper-wrap/.paper-layer 参照)。
  // アクティブな 1 枚だけは常に this.canvas(= .paper)で描く。描画・undo 本体は
  // 一切変えず、切り替えの瞬間だけ this.canvas の中身をスロットへ出し入れする。

  /** 下から順の一覧(表示用のコピー)。呼び出し側が中身を書き換えても実体には影響しない。 */
  get layerList(): { id: string; visible: boolean; opacity: number; active: boolean }[] {
    return this.layers.map((layer, index) => ({
      id: layer.id,
      visible: layer.visible,
      opacity: layer.opacity,
      active: index === this.activeIndex,
    }));
  }

  get activeLayerId(): string {
    return (this.layers[this.activeIndex] as LayerSlot).id;
  }

  get layerCount(): number {
    return this.layers.length;
  }

  /**
   * いま選んでいるレイヤーを切り替える。
   * this.canvas は常にアクティブな 1 枚の描画先なので、ここで中身を丸ごと
   * 出し入れする(合成はしない。DOM の重なりで見せるだけ)。
   */
  setActiveLayer(id: string): boolean {
    if (id === this.layers[this.activeIndex]?.id) return true;
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index === -1) return false;

    // 描きかけの線を挟んだまま切り替えると、控えに半端な線が混ざってしまう。
    this.cancelStroke();

    // いまの this.canvas の中身を現アクティブの控えへ丸ごと写す。undo 履歴も一緒に預ける。
    const current = this.layers[this.activeIndex] as LayerSlot;
    current.ctx.clearRect(0, 0, this.width, this.height);
    current.ctx.drawImage(this.canvas, 0, 0);
    current.patches = this.patches;
    current.redoPatches = this.redoPatches;

    this.activeIndex = index;
    const next = this.layers[index] as LayerSlot;
    // clearToPaper() ではなく透明へ戻す。上に乗るレイヤーは紙の色を持たないのが正しい。
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(next.canvas, 0, 0);
    this.patches = next.patches;
    this.redoPatches = next.redoPatches;

    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
    this.restack();
    return true;
  }

  /** アクティブの 1 つ上に透明な 1 枚を足し、そこをアクティブにする。新しい id を返す。 */
  addLayer(): string {
    this.cancelStroke();
    const slot = this.createLayerSlot();
    this.layers.splice(this.activeIndex + 1, 0, slot);
    // 新しいスロットは空(透明)なので、通常の切り替え経路に乗せるだけで良い。
    this.setActiveLayer(slot.id);
    return slot.id;
  }

  /** 最後の 1 枚は消せない(false を返す)。消したら隣をアクティブにする。 */
  removeLayer(id: string): boolean {
    if (this.layers.length <= 1) return false;
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index === -1) return false;

    this.cancelStroke();
    const wasActive = index === this.activeIndex;
    const [removed] = this.layers.splice(index, 1);
    removed?.canvas.remove();

    if (wasActive) {
      // 消したのがアクティブ本人。次の位置(無ければ繰り上がった末尾)へ直接読み込む。
      // 消す絵なので現アクティブ(this.canvas)の中身は控えへ退避せず捨ててよい。
      const nextIndex = Math.min(index, this.layers.length - 1);
      this.activeIndex = nextIndex;
      const next = this.layers[nextIndex] as LayerSlot;
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.drawImage(next.canvas, 0, 0);
      this.patches = next.patches;
      this.redoPatches = next.redoPatches;
      this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
    } else if (index < this.activeIndex) {
      // アクティブより前を消したので、詰まった分だけ番号がずれる。
      this.activeIndex -= 1;
    }
    this.restack();
    return true;
  }

  setLayerVisible(id: string, visible: boolean): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (layer === undefined) return;
    layer.visible = visible;
    this.restack();
  }

  /**
   * 隠れているかさねへ描き込みが起きたら、自動で見えるようにする。
   * ストローク開始・塗りつぶし・図形塗りなど、アクティブなかさねへ書き込む
   * すべての入り口の先頭で呼ぶ(このファイル内で this.ctx/this.paintCell に
   * 書き込む前を grep 済み)。隠れたまま描くと紙には何も現れず、なぜ変わらないのか
   * 子どもには分からない。「描いたら出てくる」の一本に倒せば、詰まる状態が
   * 原理的に無くなる。
   */
  private revealActiveLayerIfHidden(): void {
    const active = this.layers[this.activeIndex];
    if (active === undefined || active.visible) return;
    active.visible = true;
    this.restack();
  }

  setLayerOpacity(id: string, opacity: number): void {
    const layer = this.layers.find((candidate) => candidate.id === id);
    if (layer === undefined) return;
    layer.opacity = opacity;
    this.restack();
  }

  /** 並べ替え。toIndex は 0 が一番下。 */
  moveLayer(id: string, toIndex: number): boolean {
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index === -1) return false;
    const clamped = Math.max(0, Math.min(this.layers.length - 1, toIndex));
    if (clamped === index) return true;

    const activeId = (this.layers[this.activeIndex] as LayerSlot).id;
    const [slot] = this.layers.splice(index, 1);
    if (slot === undefined) return false;
    this.layers.splice(clamped, 0, slot);
    // 並べ替えで配列の並びが変わるので、activeIndex は id から引き直す。
    this.activeIndex = this.layers.findIndex((layer) => layer.id === activeId);
    this.restack();
    return true;
  }

  /**
   * そのかさね 1 枚だけを小さく描き写す(帯の札用)。
   * かさねは透過なので、紙の色を敷いてから描かないと札が真っ白で何も見えない
   * (toThumbnail() が合成結果の前に紙色を敷いているのと同じ理由)。
   * アクティブなかさねの画素は控え canvas ではなく this.canvas 側にある約束なので、
   * そこだけ実体を見る(composite() のコメントと同じ注意)。
   *
   * 紙は作品ごとに縦長にも横長にもなる(CANVAS_SIZES 参照)。target は正方形の的
   * (呼び出し側が width===height にして渡す約束)として扱い、紙の縦横比を保ったまま
   * 中央に描く。CSS の object-fit:contain を canvas に頼る手もあるが、実ピクセルと
   * CSS 表示サイズが食い違ったまま(元は 82x55 の実ピクセルを 82x82 の CSS 枠へ
   * 押し込んでいた)だと環境によっては引き伸ばして描かれてしまう実害があったため、
   * ここで実ピクセルの時点からレターボックス(余白は紙色のまま)にしておく。
   * 見つからなければ false。
   */
  drawLayerThumbnail(id: string, target: HTMLCanvasElement): boolean {
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index === -1) return false;
    const layer = this.layers[index] as LayerSlot;
    const source = index === this.activeIndex ? this.canvas : layer.canvas;
    this.drawScaledThumbnail(source, target);
    return true;
  }

  /**
   * 見えているものを合成して小さく描き写す(パラパラを始める確かめダイアログ用。
   * removeLayerConfirm.ts が「けす」の確かめに使うのと同じ仕組みを、「まとめる」の
   * 確かめにも転用する)。drawLayerThumbnail() と同じ縮尺・段階縮小の作法。
   */
  drawCompositeThumbnail(target: HTMLCanvasElement): void {
    this.drawScaledThumbnail(this.composite(), target);
  }

  /**
   * 縮小して小さい canvas へ描く共通処理(drawLayerThumbnail / drawCompositeThumbnail で共用)。
   * かさねは透過なので、紙の色を敷いてから描かないと札が真っ白で何も見えない
   * (toThumbnail() が合成結果の前に紙色を敷いているのと同じ理由)。
   *
   * 紙は作品ごとに縦長にも横長にもなる(CANVAS_SIZES 参照)。target は正方形の的
   * (呼び出し側が width===height にして渡す約束)として扱い、紙の縦横比を保ったまま
   * 中央に描く。CSS の object-fit:contain を canvas に頼る手もあるが、実ピクセルと
   * CSS 表示サイズが食い違ったまま(元は 82x55 の実ピクセルを 82x82 の CSS 枠へ
   * 押し込んでいた)だと環境によっては引き伸ばして描かれてしまう実害があったため、
   * ここで実ピクセルの時点からレターボックス(余白は紙色のまま)にしておく。
   *
   * 実測値: 1748x1181 の原寸を 82x82 の的へ drawImage 一発(約1/21)で縮めると、
   * 1px 程度の細い線が縮小フィルタで周囲の紙色に溶けて消える。同じ線を的の
   * 大きさだけ変えて描いた最小輝度(紙色は253相当・小さいほど濃い)は
   *   的300px … 61 / 99 / 61 (どれも見える)
   *   的82px  … 107 / 252 / 107 (真ん中が紙とほぼ同じ = 消える)
   * で、一度に大きく縮めるほど線が消えることが分かっている。ブラウザの縮小
   * フィルタは「毎回2分の1程度まで」なら間引きに追従できるので、的の大きさに
   * 一気に落とさず半分ずつ縮小して近づける(縮小の定石)。
   */
  private drawScaledThumbnail(source: CanvasImageSource, target: HTMLCanvasElement): void {
    const ctx = target.getContext("2d");
    if (ctx === null) return;
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, target.width, target.height);
    const scale = Math.min(target.width / this.width, target.height / this.height);
    const drawWidth = this.width * scale;
    const drawHeight = this.height * scale;
    const dx = (target.width - drawWidth) / 2;
    const dy = (target.height - drawHeight) / 2;

    let src = source;
    let srcW = this.width;
    let srcH = this.height;
    if (srcW > drawWidth * 2 && srcH > drawHeight * 2) {
      if (this.thumbnailScratch === null) {
        this.thumbnailScratch = [document.createElement("canvas"), document.createElement("canvas")];
      }
      const [bufA, bufB] = this.thumbnailScratch;
      let bufIndex = 0;
      while (srcW > drawWidth * 2 && srcH > drawHeight * 2) {
        const nextW = Math.max(Math.round(srcW / 2), Math.ceil(drawWidth));
        const nextH = Math.max(Math.round(srcH / 2), Math.ceil(drawHeight));
        const buf = bufIndex === 0 ? bufA : bufB;
        buf.width = nextW;
        buf.height = nextH;
        const bufCtx = buf.getContext("2d");
        if (bufCtx === null) break;
        bufCtx.drawImage(src, 0, 0, srcW, srcH, 0, 0, nextW, nextH);
        src = buf;
        srcW = nextW;
        srcH = nextH;
        bufIndex = bufIndex === 0 ? 1 : 0;
      }
    }
    ctx.drawImage(src, 0, 0, srcW, srcH, dx, dy, drawWidth, drawHeight);
  }

  /**
   * DOM の重なり順を組み直す。
   *
   * .paper-wrap の中の並びは元々:
   *   canvas.paper → .paper-overlay → .paper-texture-layer → .underlay-layer → .grid-layer
   * 後ろの 4 つは position:absolute かつ z-index なしで、DOM 順だけで重なっている。
   * これを崩さずレイヤーを差し込むため:
   *   - アクティブより下: position:absolute(.paper-layer が持つ) + 負の z-index
   *     (すぐ下が -1、その下が -2 …)。DOM 上のどこにあってもこの数字で沈む。
   *   - アクティブより上: z-index は auto のまま、.paper の直後・overlay の直前に
   *     下から順に挿す。auto 同士は DOM 順で重なるので、.paper より上・overlay より下に収まる。
   */
  private restack(): void {
    const parent = this.canvas.parentElement;
    for (let i = 0; i < this.layers.length; i += 1) {
      const layer = this.layers[i] as LayerSlot;
      if (i === this.activeIndex) {
        // アクティブの画素は this.canvas 側にあるので、控えを出すと二重に見える。
        layer.canvas.style.display = "none";
        // ただし visible/opacity の実体はこの layer.canvas ではなく this.canvas 側にある。
        // 控えを隠すだけでは this.canvas がそのまま見え続けてしまう(= 画面には出るのに
        // composite() は visible=false を飛ばすので保存 PNG と食い違う)ため、
        // 非アクティブなレイヤーと同じ見えなさをここで this.canvas にも反映する。
        // ここは visibility ではなく opacity:0 で消す(隠れたアクティブなかさねは
        // visibility:hidden にすると当たり判定ごと無くなり、pointerdown が
        // installPointerInput(canvas 直づけ)へ届かなくなる。それだと
        // revealActiveLayerIfHidden が「描いたら見せる」ために beginStroke の先頭に
        // 置いてあっても、そもそも描画イベント自体が発火せず一生届かない
        // = 隠したら二度と描けなくなる、という本末転倒が起きる。opacity:0 なら
        // 見た目は同じく消えつつ、指(マウス)は引き続き受け取れる)。
        this.canvas.style.visibility = "";
        this.canvas.style.opacity = layer.visible ? String(layer.opacity) : "0";
        continue;
      }
      layer.canvas.style.display = "";
      layer.canvas.style.visibility = layer.visible ? "" : "hidden";
      layer.canvas.style.opacity = String(layer.opacity);
      if (parent === null) continue;
      if (i < this.activeIndex) {
        // ループは i 昇順(下から上へ)回るが、z-index は「アクティブから見て
        // 何枚下か」で決まる。順に -1 ずつ振っていくと一番下(i=0)に -1(最も手前)が
        // 付いてしまい、上に行くほど奥へ沈む逆順になる(かつ index0 は clearToPaper() で
        // 塗った不透明な1枚なので、それが最前面に出ると間のレイヤーを全部隠す)。
        // 「アクティブとの距離」= i - activeIndex を使えば、すぐ下が -1、
        // 一番下が -activeIndex になり、下にあるものほど正しく奥へ回る。
        layer.canvas.style.zIndex = String(i - this.activeIndex);
        parent.appendChild(layer.canvas);
      } else {
        layer.canvas.style.zIndex = "";
        // overlay がまだ(または既に) parent の子でないタイミングで呼ばれることがあり、
        // その状態で insertBefore(…, this.overlay) すると DOM 例外で落ちる。
        // 基準にできないときは末尾へ足すだけにする(次の restack で並びは直る)。
        if (this.overlay.parentElement === parent) {
          parent.insertBefore(layer.canvas, this.overlay);
        } else {
          parent.appendChild(layer.canvas);
        }
      }
    }
  }

  /**
   * 全レイヤーを下から順に 1 枚へ焼いて合成する。紙の色は塗らない(呼び出し側が従来通り塗る)。
   * アクティブなレイヤーだけは控え canvas ではなく this.canvas(= 画素の実体)を使う。
   *
   * pick() / pickCell() / fill() はここで作った合成結果を判定に使う。
   * 線画を下のレイヤーに、色をその上の透明なレイヤーに置く使い方が一番ありそうで、
   * その場合アクティブな 1 枚(=上のレイヤー)だけを見ると囲みが無く紙全体に
   * 漏れてしまう(スポイトも下の色を吸えない)。見えているもの(合成結果)で
   * 判定し、書き込み先だけはいま選んでいる 1 枚に絞るのが正しい。
   */
  private composite(): HTMLCanvasElement {
    const flat = document.createElement("canvas");
    flat.width = this.width;
    flat.height = this.height;
    const ctx = flat.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    for (let i = 0; i < this.layers.length; i += 1) {
      const layer = this.layers[i] as LayerSlot;
      if (!layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(i === this.activeIndex ? this.canvas : layer.canvas, 0, 0);
    }
    return flat;
  }

  /** レイヤーを 1 枚に畳む(reset() / restoreFrom() の下ごしらえ)。余分な控え canvas は DOM からも外す。 */
  private collapseToSingleLayer(): void {
    for (let i = 1; i < this.layers.length; i += 1) {
      (this.layers[i] as LayerSlot).canvas.remove();
    }
    const first = this.layers[0] as LayerSlot;
    first.patches = [];
    first.redoPatches = [];
    first.visible = true;
    first.opacity = 1;
    first.canvas.style.display = "none";
    this.layers = [first];
    this.activeIndex = 0;
  }

  /**
   * 見えているかさねだけを不透明度込みで 1 枚に合成し、かさねを 1 枚に畳む
   * (docs/animation.md「パラパラの開始」)。composite() と同じ結果を、そのまま
   * かさね本体として焼き直す形になる。
   *
   * collapseToSingleLayer() とは残す 1 枚の選び方が違う(あちらは「1 枚目をそのまま
   * 残す」だけで中身を合成しない)ため、ここでは別メソッドにする。
   * - 残す 1 枚の id は **一番下** のかさねのもの(帯の一番下の札がそのまま残る形にして、
   *   まとめた後も違和感が無いようにする)。
   * - 隠れていたかさねは合成に含めないので消える。undo 履歴も捨てる
   *   (「戻す」はこの操作をまたいでは意味を持たない。取り戻したいときは、
   *   呼び出し側が直前に撮る控え(SnapshotReason "flatten")で受ける)。
   * - 紙の色は塗らない(composite() 同様、透明のまま。かさね本体は元々紙色を持たない)。
   * - 元から 1 枚だけなら何もしない。
   */
  flattenVisibleLayers(): void {
    if (this.layers.length <= 1) return;
    this.cancelStroke();
    this.clearShapePreview();

    // 畳む前に合成する(this.layers・activeIndex を変える前でないと、
    // composite() がアクティブなかさねの画素を this.canvas から正しく拾えない)。
    const flat = this.composite();

    const bottom = this.layers[0] as LayerSlot;
    // 残す 1 枚以外は DOM からも外す(collapseToSingleLayer() と同じ後始末)。
    for (let i = 1; i < this.layers.length; i += 1) {
      (this.layers[i] as LayerSlot).canvas.remove();
    }
    bottom.patches = [];
    bottom.redoPatches = [];
    bottom.visible = true;
    bottom.opacity = 1;
    bottom.canvas.style.display = "none";
    this.layers = [bottom];
    this.activeIndex = 0;

    // アクティブ(この 1 枚)の画素の実体は this.canvas 側に置く決まりなので、
    // 合成結果をそこへ描き直す。bottom.canvas(控え側)は次に切り替えるまで
    // 古いままで構わない(restack() が毎回 display:none にする約束のため)。
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(flat, 0, 0);
    this.patches = [];
    this.redoPatches = [];
    this.strokes.clear();
    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
    this.restack();
  }

  // --- 道具 -------------------------------------------------------------

  /**
   * 「ぬりつぶし」。塗った矩形を返す(何も塗らなければ null)。
   *
   * 判定は合成結果(見えているもの)で行い、書き込みはいま選んでいる 1 枚だけに絞る。
   * そのため out に別バッファを渡し、判定元の image.data は書き換えない。
   * out をそのまま this.ctx へ putImageData すると、塗っていない画素のアルファまで
   * 0 で上書きしてしまい、そのレイヤーの既存の絵が矩形ごと消える。
   * 一時 canvas に一度置いてから drawImage(source-over) で重ねることで、
   * 塗っていない画素は透明のまま素通りし、下の絵を消さずに済む。
   */
  fill(x: number, y: number, color: Rgba): FillRect | null {
    this.revealActiveLayerIfHidden();
    const flat = this.composite();
    const flatCtx = flat.getContext("2d");
    if (flatCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    const image = flatCtx.getImageData(0, 0, this.width, this.height);
    const out = new Uint8ClampedArray(image.data.length);
    const rect = floodFill(image.data, this.width, this.height, Math.round(x), Math.round(y), color, 24, 2, out);
    if (rect === null) return null;

    const patch = document.createElement("canvas");
    patch.width = this.width;
    patch.height = this.height;
    const patchCtx = patch.getContext("2d");
    if (patchCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    patchCtx.putImageData(new ImageData(out, this.width, this.height), 0, 0);

    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.drawImage(
      patch,
      rect.x, rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height,
    );
    return rect;
  }

  /**
   * 「しかく」「まる」の下見。指を動かしている間、仮の層へ **出来上がりと同じ形** を描く。
   *
   * 半透明にしたり枠線だけにしたりはしない。押す前に見えているものと、指を離した
   * あとに残るものが違うと、子どもは「押したら変わった」と受け取ってしまう。
   */
  previewShape(mode: ShapeMode, x0: number, y0: number, x1: number, y1: number, color: string, cells: CellGrid | null): void {
    this.clearShapePreview();
    const box = shapeBox(x0, y0, x1, y1, this.width, this.height);
    const rect = this.paintShape(this.overlayCtx, mode, box, color, cells);
    // 消す範囲は 1px 広めに取る(縁のアンチエイリアスが残らないように)。
    if (rect !== null) {
      this.shapePreviewDirty = {
        x: Math.max(0, rect.x - 1),
        y: Math.max(0, rect.y - 1),
        width: Math.min(this.width, rect.width + 2),
        height: Math.min(this.height, rect.height + 2),
      };
    }
  }

  /** 下見を消す。指を離したとき / ピンチに移ったときに呼ぶ。 */
  clearShapePreview(): void {
    const rect = this.shapePreviewDirty;
    if (rect === null) return;
    this.overlayCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
    this.shapePreviewDirty = null;
  }

  /**
   * 「しかく」「まる」で塗る。なぞった 2 点が対角になる枠に収める。
   * 色の境界を一切見ないので、線が切れていても、ビーズの隙間があっても漏れない。
   */
  fillShape(mode: ShapeMode, x0: number, y0: number, x1: number, y1: number, color: string, cells: CellGrid | null): FillRect | null {
    this.revealActiveLayerIfHidden();
    this.clearShapePreview();
    const box = shapeBox(x0, y0, x1, y1, this.width, this.height);
    return this.paintShape(this.ctx, mode, box, color, cells);
  }

  /** 形を 1 つ描く。塗った矩形を返す(何も塗らなければ null)。 */
  private paintShape(
    ctx: CanvasRenderingContext2D,
    mode: ShapeMode,
    box: FillRect,
    color: string,
    cells: CellGrid | null,
  ): FillRect | null {
    if (box.width <= 0 || box.height <= 0) return null;
    if (cells !== null) {
      // マス目モードは 1 マス = 1 個。欠けた半端なマスが出ると図案として使えなくなる。
      const filled = shapeCells(mode, box, cells.cellWidth, cells.cellHeight, cells.cols, cells.rows);
      for (const cell of filled) this.paintCell(cells, cell.col, cell.row, color, ctx);
      return cellsBounds(filled, cells.cellWidth, cells.cellHeight);
    }
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = color;
    if (mode === "rect") {
      ctx.fillRect(box.x, box.y, box.width, box.height);
    } else {
      ctx.beginPath();
      ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return box;
  }

  /**
   * マス目モードのスポイト。マスに置かれている色を返す。
   * 何も置いていないマスなら null(＝色を変えない)。
   * ビーズで中心の画素を読むと、穴(透明)を拾って紙の色を吸ってしまう。
   */
  pickCell(grid: CellGrid, x: number, y: number): string | null {
    // 候補点を何点も見るので、点ごとに合成し直すと重い。合成は 1 回だけにして使い回す。
    const flatCtx = this.composite().getContext("2d");
    if (flatCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    const { col, row } = cellOf(grid, x, y);
    for (const [px, py] of cellProbePoints(grid, col, row)) {
      const ix = Math.min(this.width - 1, Math.max(0, Math.floor(px)));
      const iy = Math.min(this.height - 1, Math.max(0, Math.floor(py)));
      const data = flatCtx.getImageData(ix, iy, 1, 1).data;
      if ((data[3] ?? 0) < 8) continue;
      const hex = (value: number): string => value.toString(16).padStart(2, "0");
      return `#${hex(data[0] ?? 0)}${hex(data[1] ?? 0)}${hex(data[2] ?? 0)}`;
    }
    return null;
  }

  /** 「スポイト」。合成結果(見えているもの)から吸う。透明部分(消しゴム跡)は紙の色として扱う。 */
  pick(x: number, y: number): string | null {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return null;
    const flatCtx = this.composite().getContext("2d");
    if (flatCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    const data = flatCtx.getImageData(px, py, 1, 1).data;
    const alpha = data[3] ?? 0;
    if (alpha < 8) return PAPER_COLOR;
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    return `#${hex(data[0] ?? 0)}${hex(data[1] ?? 0)}${hex(data[2] ?? 0)}`;
  }

  // --- 入出力 -----------------------------------------------------------

  /**
   * レイヤーごとの PNG を書き出す(保存用)。下から順。
   *
   * toPng() と違って紙の色は塗らない。レイヤーは重ねて初めて絵になるもので、
   * 1 枚ごとに紙色で塗り潰すと上のレイヤーが下を隠してしまい、復元したときに
   * 別の絵になってしまう(透過のまま保存して、表示側で重ねる)。
   * アクティブな 1 枚だけは画素の実体が this.canvas 側にあるので、そこを読む。
   */
  async toLayerImages(): Promise<{ id: string; image: Blob; visible: boolean; opacity: number }[]> {
    const results: { id: string; image: Blob; visible: boolean; opacity: number }[] = [];
    for (let i = 0; i < this.layers.length; i += 1) {
      const layer = this.layers[i] as LayerSlot;
      const source = i === this.activeIndex ? this.canvas : layer.canvas;
      const image = await new Promise<Blob>((resolve, reject) => {
        source.toBlob((blob) => {
          if (blob === null) reject(new Error("PNG の生成に失敗しました"));
          else resolve(blob);
        }, "image/png");
      });
      results.push({ id: layer.id, image, visible: layer.visible, opacity: layer.opacity });
    }
    return results;
  }

  /** 透明部分を紙の色で埋めた PNG を作る(保存・書き出し用)。 */
  async toPng(): Promise<Blob> {
    const flat = document.createElement("canvas");
    flat.width = this.width;
    flat.height = this.height;
    const ctx = flat.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.drawImage(this.composite(), 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      flat.toBlob((blob) => {
        if (blob === null) reject(new Error("PNG の生成に失敗しました"));
        else resolve(blob);
      }, "image/png");
    });
  }

  /**
   * 「かんせい！」で書き出す PNG。紙の質感(texture)を乗算で焼き込む。
   *
   * 方眼やビーズは「目安」なので書き出しに入れないが、紙の質感は絵の一部であり、
   * わら半紙に描いた絵が真っ白な PNG で出てきたら別の絵になってしまうので、
   * こちらは焼き込む(下敷き全般とは扱いが逆になる。理由は上記の通り)。
   *
   * 保存される作品データ(IndexedDB の PNG、toPng() 側)にはテクスチャを焼き込まない。
   * 焼き込むと後から紙を変えられなくなるうえ、変えるたびに二重に乗ってしまうため、
   * 保存は常に素の絵のままにする。一覧用サムネイル(toThumbnail())も同じ理由で焼き込まない。
   */
  async toExportPng(texture: HTMLCanvasElement | OffscreenCanvas | null): Promise<Blob> {
    const flat = document.createElement("canvas");
    flat.width = this.width;
    flat.height = this.height;
    const ctx = flat.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.drawImage(this.composite(), 0, 0);
    if (texture !== null) {
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(texture as CanvasImageSource, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    return await new Promise<Blob>((resolve, reject) => {
      flat.toBlob((blob) => {
        if (blob === null) reject(new Error("PNG の生成に失敗しました"));
        else resolve(blob);
      }, "image/png");
    });
  }

  /**
   * 一覧用の小さい PNG。原寸を並べると読み込みだけで重くなるので必ずこちらを使う。
   */
  async toThumbnail(maxWidth = 360): Promise<Blob> {
    const scale = maxWidth / this.width;
    const small = document.createElement("canvas");
    small.width = Math.round(this.width * scale);
    small.height = Math.round(this.height * scale);
    const ctx = small.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, small.width, small.height);
    ctx.drawImage(this.composite(), 0, 0, small.width, small.height);
    return await new Promise<Blob>((resolve, reject) => {
      small.toBlob((blob) => {
        if (blob === null) reject(new Error("PNG の生成に失敗しました"));
        else resolve(blob);
      }, "image/png");
    });
  }

  /** まっさらな紙に戻す(あたらしく描く)。履歴も捨てる。レイヤーも 1 枚に畳む。 */
  reset(): void {
    this.clearOverlay();
    this.collapseToSingleLayer();
    this.clearToPaper();
    this.patches = [];
    this.redoPatches = [];
    this.strokes.clear();
    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
  }

  /** 保存済み PNG を描き戻す(リロード復元)。レイヤーも 1 枚に畳む。 */
  async restoreFrom(image: Blob): Promise<void> {
    this.collapseToSingleLayer();
    const bitmap = await createImageBitmap(image);
    try {
      this.clearToPaper();
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    } finally {
      bitmap.close();
    }
    this.patches = [];
    this.redoPatches = [];
    this.strokes.clear();
    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
  }

  /**
   * 保存済みのレイヤー構成を描き戻す(リロード復元)。
   *
   * collapseToSingleLayer() は使わない。あちらは「既存の 1 枚目を残して畳む」作法だが、
   * ここでは保存されていた id をそのまま使ってスロットを作り直す必要があり、
   * 残す 1 枚を選ぶという前提そのものが合わないため。
   *
   * layers が空(古い保存データ)のときは何もしない。呼び出し側(main.ts)が
   * restoreFrom() で合成結果 1 枚に落とす前提。
   */
  async restoreLayers(
    layers: readonly { id: string; image: Blob; visible: boolean; opacity: number; deleted: boolean }[],
    activeId?: string,
  ): Promise<void> {
    if (layers.length === 0) return;

    this.cancelStroke();
    this.clearShapePreview();

    // 既存のレイヤーは全部畳んで DOM からも外す。id ごと新しく作り直すので、
    // 1 枚だけ残す collapseToSingleLayer() の作法には乗せない。
    for (const layer of this.layers) layer.canvas.remove();
    this.layers = [];

    const parent = this.canvas.parentElement;
    // ソフトデリート済みは画面に出さない。ただし全部 deleted だと 0 枚になってしまうので、
    // その時だけ id を新規に振った空の 1 枚を残す(保存データに使える id が無いため)。
    const alive = layers.filter((layer) => !layer.deleted);

    const slots: LayerSlot[] = [];
    if (alive.length === 0) {
      const empty = this.createLayerSlot();
      if (parent !== null) parent.appendChild(empty.canvas);
      slots.push(empty);
    } else {
      for (const saved of alive) {
        const slot = this.createLayerSlot();
        slot.id = saved.id;
        slot.visible = saved.visible;
        slot.opacity = saved.opacity;
        const bitmap = await createImageBitmap(saved.image);
        try {
          slot.ctx.clearRect(0, 0, this.width, this.height);
          slot.ctx.drawImage(bitmap, 0, 0, this.width, this.height);
        } finally {
          bitmap.close();
        }
        if (parent !== null) parent.appendChild(slot.canvas);
        slots.push(slot);
      }
    }
    this.layers = slots;

    // アクティブは保存されていた id を探す。見つからなければ一番上(末尾)を選ぶ
    // (線画を上に置いている子が気付かないまま下へ描いてしまう事故を避ける)。
    const foundIndex = activeId !== undefined ? this.layers.findIndex((layer) => layer.id === activeId) : -1;
    this.activeIndex = foundIndex !== -1 ? foundIndex : this.layers.length - 1;

    // アクティブに選んだ 1 枚は画素の実体を this.canvas 側に置く決まりなので、
    // そのスロットの中身を this.canvas へ写す(紙の色は塗らない。透明のままが正しい)。
    const active = this.layers[this.activeIndex] as LayerSlot;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.drawImage(active.canvas, 0, 0);
    this.patches = [];
    this.redoPatches = [];
    active.patches = [];
    active.redoPatches = [];
    this.strokes.clear();

    this.syncBackup({ x: 0, y: 0, width: this.width, height: this.height });
    this.restack();
  }
}

/**
 * 油絵の毛並みを 1 本のストロークぶん作る。
 * 位置は均等に並べたうえで少しだけ揺らし、端の毛ほど暗く薄くする
 * (絵の具が盛り上がった縁に見える)。
 */
function createBristles(count = 7): Bristle[] {
  return Array.from({ length: count }, (_, i) => {
    const base = (i / (count - 1)) * 2 - 1;
    return {
      offset: base + (Math.random() - 0.5) * 0.18,
      shade: (Math.random() - 0.5) * 0.4 - base * 0.2,
      alpha: 0.82 + Math.random() * 0.18,
    };
  });
}

/** "#rrggbb" を塗りつぶし用の RGBA へ。 */
export function hexToRgba(hex: string): Rgba {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    a: 255,
  };
}
