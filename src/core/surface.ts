// 描画面。Canvas 2D を 1 枚だけ持つ(Phase 0 はレイヤー無し)。
// 「もどる」はパッチ方式(undoStack.ts 参照)。
import { BEAD_COLS, BEAD_ROWS, CANVAS_HEIGHT, CANVAS_WIDTH } from "./model.ts";
import { floodFill, type Rgba } from "./floodFill.ts";
import { DirtyRect, MAX_STEPS, trimPatches, type FillRect, type UndoPatch } from "./undoStack.ts";
import { NIB_DEFS, strokeWidth, type NibDynamics } from "./brush.ts";

export const PAPER_COLOR = "#fffdf7";

export interface StrokeStyle {
  color: string;
  /** キャンバス座標での基準の太さ(px)。ペン先によってはここから増減する。 */
  size: number;
  /** 消しゴムは紙の色で塗るのではなく合成モードで消す。 */
  erase: boolean;
  /** ペン先の性質(速さ→太さ・入り抜き・手ブレ補正)。省略時はクレヨン(太さ一定)。 */
  dynamics?: NibDynamics;
  /**
   * アイロンビーズ / ドット絵モード。マス単位でしか置けなくなる。
   * 太さもペン先も効かない(1 マス = 1 ビーズなので、そもそも太さの概念が無い)。
   */
  beads?: boolean;
}

export const BEAD_CELL_WIDTH = CANVAS_WIDTH / BEAD_COLS;
export const BEAD_CELL_HEIGHT = CANVAS_HEIGHT / BEAD_ROWS;

/** 座標をマス番号へ。範囲外は端に丸める。 */
export function beadCellOf(x: number, y: number): { col: number; row: number } {
  return {
    col: Math.min(BEAD_COLS - 1, Math.max(0, Math.floor(x / BEAD_CELL_WIDTH))),
    row: Math.min(BEAD_ROWS - 1, Math.max(0, Math.floor(y / BEAD_CELL_HEIGHT))),
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
  /** 仮インクを描いた範囲(消すときに使う)。 */
  overlayDirty: FillRect | null;
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

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.canvas = canvas;
    this.ctx = ctx;
    const backup = document.createElement("canvas");
    backup.width = CANVAS_WIDTH;
    backup.height = CANVAS_HEIGHT;
    const backupCtx = backup.getContext("2d", { willReadFrequently: true });
    if (backupCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.backup = backup;
    this.backupCtx = backupCtx;
    const overlay = document.createElement("canvas");
    overlay.width = CANVAS_WIDTH;
    overlay.height = CANVAS_HEIGHT;
    overlay.className = "paper-overlay";
    const overlayCtx = overlay.getContext("2d");
    if (overlayCtx === null) throw new Error("2D コンテキストを取得できませんでした");
    this.overlay = overlay;
    this.overlayCtx = overlayCtx;
    this.clearToPaper();
    this.syncBackup({ x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
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
    this.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
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
      // 入り抜きのある先端は、描き終わりが分かるまで描けない。
      // 末尾を少しだけ保持しておき、endStroke でまとめて細らせながら描く。
      pending: [{ x, y, speed: 0, pressure, distance: 0 }],
    });
    if (style.beads === true) {
      const stroke = this.strokes.get(id);
      if (stroke !== undefined) this.placeBead(stroke, x, y);
    }
  }

  /** マス目に 1 つ置く。同じマスは 1 ストロークにつき 1 回だけ塗る。 */
  private placeBead(stroke: StrokeState, x: number, y: number): void {
    const { col, row } = beadCellOf(x, y);
    const key = row * BEAD_COLS + col;
    if (stroke.placedCells.has(key)) return;
    stroke.placedCells.add(key);
    this.paintCell(col, row, stroke.style.erase ? null : stroke.style.color);
    stroke.drewAnything = true;
    stroke.dirty.add(col * BEAD_CELL_WIDTH, row * BEAD_CELL_HEIGHT, 0);
    stroke.dirty.add((col + 1) * BEAD_CELL_WIDTH, (row + 1) * BEAD_CELL_HEIGHT, 0);
  }

  /**
   * マス 1 つを塗る。color=null で消す。
   * 実物のビーズに合わせて **穴あきの円** で描く。四角で埋めるより、
   * 出来上がりの見た目に近く、図案としても数えやすい。
   */
  private paintCell(col: number, row: number, color: string | null): void {
    // マスの境界は実数なので、消すときは外側へ丸めて隣に残りかすを作らない。
    const left = Math.floor(col * BEAD_CELL_WIDTH);
    const top = Math.floor(row * BEAD_CELL_HEIGHT);
    const right = Math.ceil((col + 1) * BEAD_CELL_WIDTH);
    const bottom = Math.ceil((row + 1) * BEAD_CELL_HEIGHT);

    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillRect(left, top, right - left, bottom - top);
    if (color !== null) {
      const cx = (col + 0.5) * BEAD_CELL_WIDTH;
      const cy = (row + 0.5) * BEAD_CELL_HEIGHT;
      const outer = Math.min(BEAD_CELL_WIDTH, BEAD_CELL_HEIGHT) * 0.46;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, 0, Math.PI * 2);
      ctx.fill();
      // 真ん中の穴。アイロンをかけると溶けて縮むので、小さめにして仕上がりに寄せる。
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(cx, cy, outer * 0.17, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * ビーズモードの塗りつぶし。**マス単位**で広がる。
   * 円で置くと隙間ができるので、画素をたどる塗りつぶしでは背景ごと漏れてしまう。
   * マスの中心の色を見て、同じ色のマスへ伝播させる。
   */
  fillCells(x: number, y: number, color: string): FillRect | null {
    const image = this.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    /**
     * そのマスに置かれているビーズの色。空なら "empty"。
     *
     * ビーズは真ん中に穴が空いているので、**中心を見てはいけない**
     * (穴＝透明なので、置いてあるのに「空」と判定して塗りが全面へ漏れる)。
     * 中心を外した輪の上を何点か見て、最初に見つかった色を採る。
     */
    const colorAt = (col: number, row: number): string => {
      const cx = (col + 0.5) * BEAD_CELL_WIDTH;
      const cy = (row + 0.5) * BEAD_CELL_HEIGHT;
      const ring = Math.min(BEAD_CELL_WIDTH, BEAD_CELL_HEIGHT) * 0.3;
      const probes: [number, number][] = [
        [cx + ring, cy],
        [cx - ring, cy],
        [cx, cy + ring],
        [cx, cy - ring],
      ];
      for (const [px, py] of probes) {
        const ix = Math.min(CANVAS_WIDTH - 1, Math.max(0, Math.floor(px)));
        const iy = Math.min(CANVAS_HEIGHT - 1, Math.max(0, Math.floor(py)));
        const offset = (iy * CANVAS_WIDTH + ix) * 4;
        if ((image.data[offset + 3] ?? 0) < 8) continue;
        return `#${hex(image.data[offset] ?? 0)}${hex(image.data[offset + 1] ?? 0)}${hex(image.data[offset + 2] ?? 0)}`;
      }
      return "empty";
    };

    const start = beadCellOf(x, y);
    const target = colorAt(start.col, start.row);
    if (target === color.toLowerCase()) return null;

    const seen = new Uint8Array(BEAD_COLS * BEAD_ROWS);
    const stack = [start];
    let minCol = start.col;
    let maxCol = start.col;
    let minRow = start.row;
    let maxRow = start.row;
    while (stack.length > 0) {
      const cell = stack.pop() as { col: number; row: number };
      if (cell.col < 0 || cell.row < 0 || cell.col >= BEAD_COLS || cell.row >= BEAD_ROWS) continue;
      const key = cell.row * BEAD_COLS + cell.col;
      if (seen[key] === 1) continue;
      if (colorAt(cell.col, cell.row) !== target) continue;
      seen[key] = 1;
      this.paintCell(cell.col, cell.row, color);
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

    const left = Math.floor(minCol * BEAD_CELL_WIDTH);
    const top = Math.floor(minRow * BEAD_CELL_HEIGHT);
    return {
      x: left,
      y: top,
      width: Math.ceil((maxCol + 1) * BEAD_CELL_WIDTH) - left,
      height: Math.ceil((maxRow + 1) * BEAD_CELL_HEIGHT) - top,
    };
  }

  extendStroke(id: number, x: number, y: number, time = 0, pressure?: number): void {
    const stroke = this.strokes.get(id);
    if (stroke === undefined) return;

    if (stroke.style.beads === true) {
      // 速く動かすとイベントが飛ぶので、前の点との間を補間して通過したマスを埋める。
      // 手ブレ補正も速さによる太さも要らない(マスに吸着するので意味を持たない)。
      const steps = Math.ceil(
        Math.max(
          Math.abs(x - stroke.lastX) / BEAD_CELL_WIDTH,
          Math.abs(y - stroke.lastY) / BEAD_CELL_HEIGHT,
        ),
      );
      for (let i = 1; i <= Math.max(1, steps); i += 1) {
        const t = i / Math.max(1, steps);
        this.placeBead(stroke, stroke.lastX + (x - stroke.lastX) * t, stroke.lastY + (y - stroke.lastY) * t);
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
      const rect = stroke.dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);
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

    if (stroke.style.beads === true) return stroke.dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);

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
    return stroke.dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);
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
      width: Math.min(CANVAS_WIDTH, Math.ceil(maxX + pad)) - x,
      height: Math.min(CANVAS_HEIGHT, Math.ceil(maxY + pad)) - y,
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
  ): void {
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
    this.overlayCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (const stroke of this.strokes.values()) stroke.overlayDirty = null;
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

  // --- 道具 -------------------------------------------------------------

  /** 「ぬりつぶし」。塗った矩形を返す(何も塗らなければ null)。 */
  fill(x: number, y: number, color: Rgba): FillRect | null {
    const image = this.ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const rect = floodFill(image.data, CANVAS_WIDTH, CANVAS_HEIGHT, Math.round(x), Math.round(y), color);
    if (rect === null) return null;
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.putImageData(image, 0, 0);
    return rect;
  }

  /** 「スポイト」。透明部分(消しゴム跡)は紙の色として扱う。 */
  pick(x: number, y: number): string | null {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= CANVAS_WIDTH || py >= CANVAS_HEIGHT) return null;
    const data = this.ctx.getImageData(px, py, 1, 1).data;
    const alpha = data[3] ?? 0;
    if (alpha < 8) return PAPER_COLOR;
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    return `#${hex(data[0] ?? 0)}${hex(data[1] ?? 0)}${hex(data[2] ?? 0)}`;
  }

  // --- 入出力 -----------------------------------------------------------

  /** 透明部分を紙の色で埋めた PNG を作る(保存・書き出し用)。 */
  async toPng(): Promise<Blob> {
    const flat = document.createElement("canvas");
    flat.width = CANVAS_WIDTH;
    flat.height = CANVAS_HEIGHT;
    const ctx = flat.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.drawImage(this.canvas, 0, 0);
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
    const scale = maxWidth / CANVAS_WIDTH;
    const small = document.createElement("canvas");
    small.width = Math.round(CANVAS_WIDTH * scale);
    small.height = Math.round(CANVAS_HEIGHT * scale);
    const ctx = small.getContext("2d");
    if (ctx === null) throw new Error("2D コンテキストを取得できませんでした");
    ctx.fillStyle = PAPER_COLOR;
    ctx.fillRect(0, 0, small.width, small.height);
    ctx.drawImage(this.canvas, 0, 0, small.width, small.height);
    return await new Promise<Blob>((resolve, reject) => {
      small.toBlob((blob) => {
        if (blob === null) reject(new Error("PNG の生成に失敗しました"));
        else resolve(blob);
      }, "image/png");
    });
  }

  /** まっさらな紙に戻す(あたらしく描く)。履歴も捨てる。 */
  reset(): void {
    this.clearOverlay();
    this.clearToPaper();
    this.patches = [];
    this.redoPatches = [];
    this.strokes.clear();
    this.syncBackup({ x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  }

  /** 保存済み PNG を描き戻す(リロード復元)。 */
  async restoreFrom(image: Blob): Promise<void> {
    const bitmap = await createImageBitmap(image);
    try {
      this.clearToPaper();
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.drawImage(bitmap, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    } finally {
      bitmap.close();
    }
    this.patches = [];
    this.redoPatches = [];
    this.strokes.clear();
    this.syncBackup({ x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  }
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
