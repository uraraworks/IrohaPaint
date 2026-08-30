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

  /**
   * ボタンの真上(左バーなら右横)に、画面からはみ出さない位置で置く。
   *
   * 以前は top をパネルの高さから逆算していた(`top = ボタン上端 - パネル高さ - 余白`)。
   * パネルは中身(サブメニューの選択など)が変わると行数が増減し、高さが変わっていく。
   * 高さから上端を逆算すると、その変化の途中の高さを拾ってしまい、変化が終わったあと
   * 下端がずれる(浮いて見える)。下端を直接指定すれば測定そのものが要らなくなり、
   * いつ再計算しても同じ結果になる — パネルは常に上へ伸び縮みするだけで下端は動かない。
   * 左バー配置の縦中央寄せも同じ理由で、高さを測る代わりに transform: translateY(-50%)
   * を使う。横方向(中央寄せ)だけは .grid-panel の max-width で幅がすでに閉じ込めて
   * あり、幅はアニメーション中も変わらないので、はみ出し防止のクランプのために測ってよい。
   */
  private position(anchor: HTMLElement): void {
    const button = anchor.getBoundingClientRect();
    const margin = 12;
    const leftBar = document.body.querySelector(".app")?.classList.contains("bar-left") === true;
    const panelWidth = this.element.offsetWidth;

    if (leftBar) {
      let left = button.right + margin;
      left = Math.min(Math.max(margin, left), window.innerWidth - panelWidth - margin);
      const centerY = Math.min(Math.max(margin, button.top + button.height / 2), window.innerHeight - margin);
      this.element.style.left = `${left}px`;
      this.element.style.bottom = "";
      this.element.style.top = `${centerY}px`;
      this.element.style.transform = "translateY(-50%)";
    } else {
      // ツールバー上端から余白ぶん上にパネルの下端を置く。
      const bar = document.querySelector(".toolbar")?.getBoundingClientRect();
      const barTop = bar?.top ?? window.innerHeight;
      const bottom = window.innerHeight - barTop + margin;

      let left = button.left + button.width / 2 - panelWidth / 2;
      left = Math.min(Math.max(margin, left), window.innerWidth - panelWidth - margin);
      this.element.style.left = `${left}px`;
      this.element.style.top = "";
      this.element.style.bottom = `${bottom}px`;
      this.element.style.transform = "";
    }
  }
}
