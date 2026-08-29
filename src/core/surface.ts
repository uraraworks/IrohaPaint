// 描画面。Canvas 2D を 1 枚だけ持つ(Phase 0 はレイヤー無し)。
// 「もどる」はパッチ方式(undoStack.ts 参照)。
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./model.ts";
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
  private patches: UndoPatch[] = [];
  /** 「戻る」で巻き戻した分。新しく描いたら捨てる(一般的なペイントと同じ作法)。 */
  private redoPatches: UndoPatch[] = [];
  private dirty: DirtyRect | null = null;
  private strokeStyle: StrokeStyle | null = null;
  private dynamics: NibDynamics = NIB_DEFS.crayon.dynamics;
  /** 手ブレ補正後の現在位置。 */
  private smoothX = 0;
  private smoothY = 0;
  private lastTime = 0;
  /** 直前に実際に描いた点。 */
  private lastX = 0;
  private lastY = 0;
  private lastWidth = 0;
  private travelled = 0;
  private pending: PendingPoint[] = [];
  private drewAnything = false;

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

  beginStroke(x: number, y: number, style: StrokeStyle, time = 0, pressure?: number): void {
    this.strokeStyle = style;
    this.dynamics = style.dynamics ?? NIB_DEFS.crayon.dynamics;
    this.dirty = new DirtyRect();
    this.smoothX = x;
    this.smoothY = y;
    this.lastTime = time;
    this.lastX = x;
    this.lastY = y;
    this.lastWidth = style.size;
    this.travelled = 0;
    this.drewAnything = false;
    // 入り抜きのある先端は、描き終わりが分かるまで描けない。
    // 末尾を少しだけ保持しておき、endStroke でまとめて細らせながら描く。
    this.pending = [{ x, y, speed: 0, pressure, distance: 0 }];
    this.dirty.add(x, y, style.size * this.dynamics.maxWidthRatio);
  }

  extendStroke(x: number, y: number, time = 0, pressure?: number): void {
    const style = this.strokeStyle;
    if (style === null || this.dirty === null) return;

    // 手ブレ補正。指の細かい揺れを吸収する。数フレームぶん遅れるが、
    // 線の見た目が落ち着く効果の方がはるかに大きい。
    const alpha = 1 - this.dynamics.smoothing;
    const prevX = this.smoothX;
    const prevY = this.smoothY;
    this.smoothX += (x - this.smoothX) * alpha;
    this.smoothY += (y - this.smoothY) * alpha;

    const step = Math.hypot(this.smoothX - prevX, this.smoothY - prevY);
    if (step < 0.01) return;
    // 端末やイベントの詰まりで dt が壊れても速さが暴れないよう範囲を絞る。
    const dt = Math.min(100, Math.max(1, time - this.lastTime));
    this.lastTime = time;
    this.travelled += step;
    this.pending.push({
      x: this.smoothX,
      y: this.smoothY,
      speed: step / dt,
      pressure,
      distance: this.travelled,
    });
    this.dirty.add(this.smoothX, this.smoothY, style.size * this.dynamics.maxWidthRatio);

    // 末尾(抜きに使う長さ)より古い点は、もう細らせる必要がないので確定して描く。
    while (this.pending.length > 1) {
      const head = this.pending[0] as PendingPoint;
      if (this.travelled - head.distance <= this.dynamics.taperOutPx) break;
      this.pending.shift();
      this.renderPoint(head, Number.POSITIVE_INFINITY, style);
    }
  }

  /**
   * 描きかけの線を無かったことにする(ピンチに移行した時)。
   * 控え(1 手前の状態)から描き戻すので、undo 履歴は消費しない。
   */
  cancelStroke(): void {
    const dirty = this.dirty;
    this.dirty = null;
    this.strokeStyle = null;
    this.pending = [];
    if (dirty === null) return;
    const rect = dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);
    if (rect === null) return;
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    this.ctx.drawImage(
      this.backup,
      rect.x, rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height,
    );
  }

  /** ストロークを確定し、undo 用に変更前の画素を積む。戻り値は変更矩形。 */
  endStroke(): FillRect | null {
    const dirty = this.dirty;
    const style = this.strokeStyle;
    if (dirty !== null && style !== null) {
      // 残しておいた末尾を、終端に近づくほど細くしながら描く。
      for (const point of this.pending) {
        this.renderPoint(point, this.travelled - point.distance, style);
      }
      // 「ちょん」と置いただけの点も必ず残す(子どもは点を打つ)。
      if (!this.drewAnything) {
        const width = Math.max(2, style.size * (style.dynamics === undefined ? 1 : 0.6));
        this.paintDot(this.lastX, this.lastY, width, style);
      }
    }
    this.pending = [];
    this.dirty = null;
    this.strokeStyle = null;
    if (dirty === null) return null;
    return dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  /** 1 点ぶんを、直前の点からの線として描く。 */
  private renderPoint(point: PendingPoint, distanceFromEnd: number, style: StrokeStyle): void {
    const width = strokeWidth(
      style.size,
      this.dynamics,
      point.speed,
      point.pressure,
      point.distance,
      distanceFromEnd,
    );
    if (point.x !== this.lastX || point.y !== this.lastY) {
      // 太さは点ごとに変わるので、区間の平均で描く。区間が短いので段差は見えない。
      this.paintLine(this.lastX, this.lastY, point.x, point.y, (this.lastWidth + width) / 2, style);
      this.drewAnything = true;
    }
    this.lastX = point.x;
    this.lastY = point.y;
    this.lastWidth = width;
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
  commit(rect: FillRect): void {
    const before = this.backupCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
    this.patches = trimPatches([...this.patches, { ...rect, before }]);
    // 巻き戻した先から描き直したら、その先の未来は無くなる。
    this.redoPatches = [];
    this.syncBackup(rect);
  }

  /** 控えの指定矩形を現在のキャンバスで置き換える。消しゴム跡(透明)も含めて写す。 */
  private syncBackup(rect: FillRect): void {
    this.backupCtx.globalCompositeOperation = "source-over";
    this.backupCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
    this.backupCtx.drawImage(
      this.canvas,
      rect.x, rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height,
    );
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
    this.clearToPaper();
    this.patches = [];
    this.redoPatches = [];
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
