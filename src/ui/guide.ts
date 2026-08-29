// 吹き出しガイド。
//
// プロト仕様書§5:
//   - 出すのは道具が増えた瞬間だけ。起動直後は何も出さない
//   - 1 回に 1 個 / 7 文字前後 / ひらがな
//   - 無視して描き続けてよい。描いていれば勝手に消える。連続表示しない
//   - スキップ不可の強制ステップは作らない

export class GuideBubble {
  private readonly element: HTMLElement;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "guide-bubble";
    this.element.setAttribute("role", "status");
    parent.appendChild(this.element);
  }

  /** anchor の上に吹き出しを出す。既に出ていれば置き換える(重ねない)。 */
  show(text: string, anchor: HTMLElement, durationMs = 6000): void {
    this.element.textContent = text;
    this.element.classList.add("is-visible");
    const rect = anchor.getBoundingClientRect();
    this.element.style.left = `${rect.left + rect.width / 2}px`;
    this.element.style.top = `${rect.top}px`;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), durationMs);
  }

  hide(): void {
    this.element.classList.remove("is-visible");
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
