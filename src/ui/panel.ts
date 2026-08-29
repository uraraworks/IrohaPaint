// ツールバーのボタンから「ぽよん」と開くパネル。
// パネル外タップで閉じる / 開閉はいつでも何度でも(失敗が存在しない)。

export class Panel {
  readonly element: HTMLElement;
  private anchor: HTMLElement | null = null;

  constructor(parent: HTMLElement, className: string) {
    this.element = document.createElement("div");
    this.element.className = `panel ${className}`;
    parent.appendChild(this.element);
  }

  get isOpen(): boolean {
    return this.element.classList.contains("is-open");
  }

  toggle(anchor: HTMLElement): void {
    if (this.isOpen && this.anchor === anchor) this.close();
    else this.open(anchor);
  }

  open(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.element.classList.add("is-open");
    this.position(anchor);
  }

  close(): void {
    this.element.classList.remove("is-open");
    this.anchor = null;
  }

  /** ボタンの真上(左バーなら右横)に、画面からはみ出さない位置で置く。 */
  private position(anchor: HTMLElement): void {
    const button = anchor.getBoundingClientRect();
    // getBoundingClientRect は開閉アニメーション中の transform(scale 0.6) を反映してしまい、
    // 実寸より小さい値を返す。レイアウト上の大きさが要るので offset* を使う。
    const panel = { width: this.element.offsetWidth, height: this.element.offsetHeight };
    const margin = 12;
    const leftBar = document.body.querySelector(".app")?.classList.contains("bar-left") === true;

    let left: number;
    let top: number;
    if (leftBar) {
      left = button.right + margin;
      top = button.top + button.height / 2 - panel.height / 2;
    } else {
      left = button.left + button.width / 2 - panel.width / 2;
      top = button.top - panel.height - margin;
    }
    // ツールバーに重ねない。重なるとパネル越しにボタンを押してしまう。
    const bar = document.querySelector(".toolbar")?.getBoundingClientRect();
    const limitTop = leftBar || bar === undefined ? window.innerHeight : bar.top;
    left = Math.min(Math.max(margin, left), window.innerWidth - panel.width - margin);
    top = Math.min(Math.max(margin, top), limitTop - panel.height - margin);
    top = Math.max(margin, top);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }
}
