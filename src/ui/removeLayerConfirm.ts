// 「けす」の確かめ。かさねを消す操作は元に戻せない(undo の対象外。surface.ts の
// removeLayer 参照)ため、押した直後にもう一段、画面中央で確かめを挟む。
//
// ボタンを「はい/いいえ」にしない理由:
// 「はい」が何に対しての肯定かは、質問文(「けしますか？」)を読めて初めて分かる。
// 字が読めない子には、押した結果がそのままボタンに書いてある「けす」「やめる」の方が
// 確実(動詞そのものを書く)。
//
// 外側タップ/Esc でも閉じられるようにしてあるのは意図的: guide.ts 冒頭に
// 「スキップ不可の強制ステップは作らない」とあるのがこのアプリの家の作法で、
// 逃げ道の無いモーダルはそこから外れる。閉じても「やめる」と同じ、何も起きない
// 安全側に倒れるだけなので、閉じ道を塞ぐ理由が無い。
//
// どのかさねを消そうとしているかは字ではなく絵(帯の札と同じサムネイル)で示す。
// これも「字が読めなくても分かる」を優先する、このアプリ全体の作法に合わせたもの。
import type { LabelPart } from "../core/tools.ts";
import { renderRuby } from "./label.ts";

export interface RemoveLayerConfirmHandlers {
  onConfirm(id: string): void;
  onCancel(): void;
}

/** 呼び出し側が Surface.drawLayerThumbnail 等で canvas に絵を書き込むための窓口。 */
export type ThumbnailRenderer = (canvas: HTMLCanvasElement) => void;

const TEXT = {
  // 漢字が無い文言だが、他の UI 文言と同じく必ず renderRuby() を通す(L3 切替時の
  // 扱いを他と揃えるため。renderRuby はふりがな無しの部分をそのまま文字にする)。
  message: [{ base: "けしますか？" }],
  confirm: [{ base: "けす" }],
  cancel: [{ base: "やめる" }],
} satisfies Record<string, LabelPart[]>;

export class RemoveLayerConfirm {
  private readonly backdrop: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly thumb: HTMLCanvasElement;
  private readonly handlers: RemoveLayerConfirmHandlers;
  private targetId: string | null = null;
  private keydownListener: ((event: KeyboardEvent) => void) | null = null;

  constructor(parent: HTMLElement, handlers: RemoveLayerConfirmHandlers) {
    this.handlers = handlers;

    this.backdrop = document.createElement("div");
    this.backdrop.className = "remove-confirm-backdrop";
    // 背景そのもの(= dialog の外側)を触ったときだけ閉じる。dialog 内でのタップが
    // バブリングして誤閉じしないよう、target がこの backdrop 自身かで判定する。
    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.cancel();
    });

    this.dialog = document.createElement("div");
    this.dialog.className = "remove-confirm";
    this.dialog.setAttribute("role", "alertdialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.backdrop.appendChild(this.dialog);

    const message = document.createElement("p");
    message.className = "remove-confirm-message";
    message.appendChild(renderRuby(TEXT.message));
    this.dialog.appendChild(message);

    // 消そうとしているかさねの絵。帯の札(.layer-tile-thumb)と同じ役割なので
    // クラス名も揃えて、角丸・枠のスタイルをそのまま借りる。
    this.thumb = document.createElement("canvas");
    this.thumb.className = "layer-tile-thumb remove-confirm-thumb";
    this.dialog.appendChild(this.thumb);

    const buttons = document.createElement("div");
    buttons.className = "remove-confirm-buttons";
    // 押し間違い防止で2つのボタンを大きく離す(CSS 側の gap/justify-content)。
    // 安全側の「やめる」を先(左)に置き、指の動線が短い側に取り返しのつく方を置く。
    const cancelButton = document.createElement("button");
    cancelButton.className = "remove-confirm-cancel";
    cancelButton.appendChild(renderRuby(TEXT.cancel));
    cancelButton.addEventListener("click", () => this.cancel());
    buttons.appendChild(cancelButton);

    const confirmButton = document.createElement("button");
    confirmButton.className = "remove-confirm-confirm";
    confirmButton.appendChild(renderRuby(TEXT.confirm));
    confirmButton.addEventListener("click", () => this.confirm());
    buttons.appendChild(confirmButton);

    this.dialog.appendChild(buttons);
    parent.appendChild(this.backdrop);
  }

  get isVisible(): boolean {
    return this.backdrop.classList.contains("is-visible");
  }

  /**
   * size は帯の札と同じ実ピクセル寸法(呼び出し側の layerThumbnailSize() 参照)。
   * canvas は width/height を書き換えると中身が消えるため、変わっていないときは
   * 触らない(layerStrip.ts の syncLayerStrip と同じ流儀)。
   */
  show(id: string, size: number, renderThumbnail: ThumbnailRenderer): void {
    this.targetId = id;
    if (this.thumb.width !== size || this.thumb.height !== size) {
      this.thumb.width = size;
      this.thumb.height = size;
    }
    renderThumbnail(this.thumb);
    this.backdrop.classList.add("is-visible");
    // Esc で閉じる。「やめる」ボタンと同じ扱い(安全側)。開いている間だけ張り、
    // 閉じたら必ず外す(張りっぱなしだと他の画面のキー操作に紛れて悪さをする)。
    this.keydownListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.cancel();
    };
    window.addEventListener("keydown", this.keydownListener);
  }

  private hide(): void {
    this.backdrop.classList.remove("is-visible");
    this.targetId = null;
    if (this.keydownListener !== null) {
      window.removeEventListener("keydown", this.keydownListener);
      this.keydownListener = null;
    }
  }

  private cancel(): void {
    if (this.targetId === null) return;
    this.hide();
    this.handlers.onCancel();
  }

  private confirm(): void {
    const id = this.targetId;
    if (id === null) return;
    this.hide();
    this.handlers.onConfirm(id);
  }
}
