// 下敷きの取り込みパイプライン。
//
// 「ファイルを開いて下敷き 1 枚(UnderlayRecord)にする」までの一連の処理。
// vitest がブラウザ API(createImageBitmap / canvas)を持たない node 環境で動くため、
// 判断ロジック(検査・符号化の選択)とブラウザ API を叩く処理を明確に分ける。
// 前者だけがテスト対象。
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./model.ts";
import { createUnderlay, fitSize, type UnderlayRecord } from "./underlay.ts";

/** 取り込めるファイルサイズの上限。これを超えるとデコードでタブが固まりうる。 */
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

/** 一覧のカードに出すサムネイルの長辺。ここも fitSize() で寸法を出せる。 */
export const UNDERLAY_THUMB_EDGE = 256;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** 取り込める画像の種類か(GIF はアニメーションでも 1 コマ目が使われる)。 */
export function isSupportedImageType(type: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(type);
}

/**
 * 保存するときの符号化を選ぶ。
 * PNG はそのまま PNG(透過を保つ。絵を取り込んだときに背景が黒くならない)。
 * それ以外は JPEG(写真を PNG で持つとサイズが桁で膨らむため)。
 */
export function chooseEncoding(sourceType: string): { type: string; quality: number } {
  if (sourceType === "image/png") {
    // quality は PNG では無視されるが、呼び出し側で分岐せず同じ形で扱えるようにしておく。
    return { type: "image/png", quality: 1 };
  }
  return { type: "image/jpeg", quality: 0.85 };
}

export type UnderlayImportErrorCode = "unsupportedType" | "tooLarge" | "decodeFailed" | "encodeFailed";

/**
 * 取り込みの失敗。
 * この層は表示文言を持たず code だけを持つ(画面に出す言葉は UI 側の責任。
 * 層をまたいで文言を持ち回らない)。
 */
export class UnderlayImportError extends Error {
  readonly code: UnderlayImportErrorCode;

  constructor(code: UnderlayImportErrorCode) {
    // super() には code をそのまま渡す。これは利用者に見せる文言ではなく、
    // デバッグ時にスタックトレース上で原因が分かるようにするためだけのもの。
    super(code);
    this.code = code;
    this.name = "UnderlayImportError";
  }
}

/** 種類とサイズの検査。問題があれば UnderlayImportError を投げる。 */
export function validateFile(file: { type: string; size: number }): void {
  if (!isSupportedImageType(file.type)) {
    throw new UnderlayImportError("unsupportedType");
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new UnderlayImportError("tooLarge");
  }
}

/**
 * ファイルを下敷き 1 枚に取り込む。
 * ここから先はブラウザ API に触るためテストしない(vitest は node 環境で DOM が無い)。
 *
 * canvasWidth/canvasHeight は取り込み先の作品の寸法。既定(横長 1748x1181)のまま
 * だと、縦長の作品に取り込んだときの初期配置(contain)が実際の紙と合わなくなるため、
 * 呼び出し側(main.ts)がいま開いている作品の寸法を渡す。
 */
export async function importUnderlay(
  file: File,
  now: number,
  canvasWidth: number = CANVAS_WIDTH,
  canvasHeight: number = CANVAS_HEIGHT,
): Promise<UnderlayRecord> {
  validateFile(file);

  let bitmap: ImageBitmap;
  try {
    // imageOrientation: "from-image" は必須。iPhone で撮った写真は EXIF に回転情報を
    // 持って来るため、これが無いと横倒しの下敷きになる。
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new UnderlayImportError("decodeFailed");
  }

  try {
    const size = fitSize(bitmap.width, bitmap.height);
    const blob = await encodeToBlob(bitmap, size.width, size.height, chooseEncoding(file.type));
    // サムネイルも同じ ImageBitmap から作る(デコードは 1 回だけにする。数MBの写真を2回デコードしない)。
    // 一覧に並ぶ小さい絵に透過は要らないので、常に JPEG(白背景)にしてサイズを削る。
    const thumbSize = fitSize(bitmap.width, bitmap.height, UNDERLAY_THUMB_EDGE);
    const thumbnail = await encodeToBlob(bitmap, thumbSize.width, thumbSize.height, {
      type: "image/jpeg",
      quality: 0.7,
    });
    return createUnderlay(blob, size.width, size.height, now, thumbnail, canvasWidth, canvasHeight);
  } finally {
    // デコード済み画像は数十 MB を占めるので放置しない。
    bitmap.close();
  }
}

/**
 * canvas に bitmap を width x height で描画する。
 * JPEG(encoding.type !== "image/png")のときだけ、描画前に全面を白で塗る。
 * JPEG は透過を持てないため、塗らずに drawImage すると透けていた部分が
 * 黒く抜けてしまう(下敷きが黒い矩形になる)。紙は白いので白で埋めるのが自然。
 * PNG のときは塗らず、透過をそのまま保つ。
 */
function paintBitmap(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
  encoding: { type: string; quality: number },
): void {
  if (encoding.type !== "image/png") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
}

/** bitmap を width x height に縮小描画し、指定の符号化で Blob 化する。 */
async function encodeToBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  encoding: { type: string; quality: number },
): Promise<Blob> {
  // OffscreenCanvas があればそれを使うが、Safari の版によっては
  // OffscreenCanvas.convertToBlob が無いため、実際に使える経路を選ぶ。
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx && typeof canvas.convertToBlob === "function") {
      paintBitmap(ctx, bitmap, width, height, encoding);
      try {
        return await canvas.convertToBlob({ type: encoding.type, quality: encoding.quality });
      } catch {
        throw new UnderlayImportError("encodeFailed");
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new UnderlayImportError("encodeFailed");
  }
  paintBitmap(ctx, bitmap, width, height, encoding);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new UnderlayImportError("encodeFailed"));
      },
      encoding.type,
      encoding.quality,
    );
  });
}
