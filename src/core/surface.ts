// 描画面。Canvas 2D を 1 枚だけ持つ(Phase 0 はレイヤー無し)。
// 「もどる」はパッチ方式(undoStack.ts 参照)。
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./model.ts";
import { floodFill, type Rgba } from "./floodFill.ts";
import { DirtyRect, MAX_STEPS, trimPatches, type FillRect, type UndoPatch } from "./undoStack.ts";

export const PAPER_COLOR = "#fffdf7";

export interface StrokeStyle {
  color: string;
  /** キャンバス座標での太さ(px)。 */
  size: number;
  /** 消しゴムは紙の色で塗るのではなく合成モードで消す。 */
  erase: boolean;
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
  private lastX = 0;
  private lastY = 0;
  private strokeStyle: StrokeStyle | null = null;

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

  beginStroke(x: number, y: number, style: StrokeStyle): void {
    this.strokeStyle = style;
    this.dirty = new DirtyRect();
    this.lastX = x;
    this.lastY = y;
    this.dirty.add(x, y, style.size);
    // 点タップでも必ず 1 点は落ちるようにする(子どもは「ちょん」と置く)。
    this.paintSegment(x, y, x, y, style);
  }

  extendStroke(x: number, y: number): void {
    const style = this.strokeStyle;
    if (style === null || this.dirty === null) return;
    this.paintSegment(this.lastX, this.lastY, x, y, style);
    this.dirty.add(x, y, style.size);
    this.lastX = x;
    this.lastY = y;
  }

  /**
   * 描きかけの線を無かったことにする(ピンチに移行した時)。
   * 控え(1 手前の状態)から描き戻すので、undo 履歴は消費しない。
   */
  cancelStroke(): void {
    const dirty = this.dirty;
    this.dirty = null;
    this.strokeStyle = null;
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
    this.dirty = null;
    this.strokeStyle = null;
    if (dirty === null) return null;
    const rect = dirty.toRect(CANVAS_WIDTH, CANVAS_HEIGHT);
    return rect;
  }

  private paintSegment(x0: number, y0: number, x1: number, y1: number, style: StrokeStyle): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = style.erase ? "destination-out" : "source-over";
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineWidth = style.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (x0 === x1 && y0 === y1) {
      ctx.beginPath();
      ctx.arc(x0, y0, style.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
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
