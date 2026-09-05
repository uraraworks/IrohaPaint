// かさね(レイヤー)の帯。画面左端に縦に並ぶ、かさねの一覧。
//
// 画面に出す言葉は必ず「かさね」。「レイヤー」「重ね合わせ」は出さない
// (前者はカタカナで子どもに絵が浮かばず、後者は語呂が長くてボタンに収まらない)。
// コード上の識別子は layer のままでよい。
//
// Surface.layerList は index 0 が一番下の約束(surface.ts 参照)。
// この帯は「上に表示される札が上のかさね」なので、並べるときは必ず逆順にたどる。
//
// 実際の増やす/消す/並び替え等の操作はここでは一切行わない。押されたことだけを
// ハンドラへ伝え、Surface を触るのは呼び出し側(main.ts)の役目にする
// (このモジュールは Surface を知らなくてよい形にしておく)。
import { plainText, renderRuby } from "./label.ts";
import { CHEVRON_DOWN_SVG, CHEVRON_UP_SVG, EYE_CLOSED_SVG, EYE_OPEN_SVG, NEW_PAGE_SVG } from "./icons.ts";

/** 帯の 1 枚ぶんの状態。Surface.layerList の要素とそのまま渡し合える形にしてある。 */
export interface LayerStripItem {
  id: string;
  visible: boolean;
  opacity: number;
  active: boolean;
}

export interface LayerStripHandlers {
  onSelect(id: string): void;
  onToggleVisible(id: string): void;
  onMove(id: string, direction: "up" | "down"): void;
  onAdd(): void;
  onRemove(id: string): void;
}

/** 帯の中の絵を書き込ませるための窓口。呼び出し側が Surface.drawLayerThumbnail() 等を呼ぶ。 */
export type ThumbnailRenderer = (id: string, canvas: HTMLCanvasElement) => void;

const TEXT = {
  add: [{ base: "＋" }, { base: "ふ" }, { base: "やす" }],
  remove: [{ base: "けす" }],
  select: [{ base: "この" }, { base: "かさねに" }, { base: "きりかえる" }],
  up: [{ base: "うえへ" }],
  down: [{ base: "したへ" }],
  show: [{ base: "みせる" }],
  hide: [{ base: "かくす" }],
} as const;

export class LayerStrip {
  readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private readonly handlers: LayerStripHandlers;

  constructor(parent: HTMLElement, handlers: LayerStripHandlers) {
    this.handlers = handlers;
    this.element = document.createElement("div");
    this.element.className = "layer-strip";
    this.track = document.createElement("div");
    this.track.className = "layer-strip-track";
    this.element.appendChild(this.track);
    parent.appendChild(this.element);
    this.installOverflowFade();
  }

  /**
   * 帯は .stage に収まる高さで頭打ちにしてあり(style.css の .layer-strip 参照)、
   * かさねが増えて入りきらなくなった分は .layer-strip-track の overflow-y: auto で
   * 縦にスクロールして辿り着く。ただしスクロールできる、という手がかりが無いと
   * 「下の札は見えなくなった(壊れた)」に見えてしまう。
   *
   * これはパネルの行(src/ui/hscroll.ts)が横スクロールで抱えているのと同じ問題
   * なので、同じ作法(隠れている側の端をぼかして「まだ先がある」を見せる、
   * 送りボタンは付けない)を縦にも適用する。送りボタンを付けない理由も同じ:
   * 8 枚もの札が並ぶと送りボタンが縦にずらずら並び、他の操作ボタンと紛れる
   * (hscroll.ts のコメント参照)。ここでは track が 1 つしか無く、横の
   * installHScroll ほど仕組みを共有する動機が薄いので、素直に書き下ろす。
   */
  private installOverflowFade(): void {
    const sync = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = this.track;
      const max = scrollHeight - clientHeight;
      this.track.classList.toggle("is-overflow-top", scrollTop > 2);
      this.track.classList.toggle("is-overflow-bottom", scrollTop < max - 2);
    };
    this.track.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    // sync() で札を組み直すたびに枚数(≒中身の高さ)が変わるので、ResizeObserver で
    // 拾う(hscroll.ts の installHScroll と同じ考え方)。
    new ResizeObserver(sync).observe(this.track);
    sync();
  }

  get isVisible(): boolean {
    return this.element.classList.contains("is-visible");
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle("is-visible", visible);
  }

  /**
   * 一覧を渡して札を組み直す。renderThumbnail が渡されたときは、組み直した直後に
   * 札ごとの canvas へ絵を書き込ませる(呼び出し側が Surface.drawLayerThumbnail を呼ぶ)。
   *
   * 常時は呼ばない前提(main.ts 側で「描き終わり・undo・redo」等、履歴が動く
   * タイミングにだけ乗せる)。毎フレーム描き直すと描き心地に響くため。
   */
  sync(items: readonly LayerStripItem[], renderThumbnail?: ThumbnailRenderer): void {
    this.track.innerHTML = "";

    // 「＋ふやす」は帯の末尾(＝一番上の札のさらに上)に置く。
    this.track.appendChild(this.buildAddTile());

    // layerList は下から順(index 0 が一番下)。上から表示したいので逆順にたどる。
    // 逆順にした並びの先頭(index 0)がいちばん上のかさねになる。
    const display = [...items].reverse();
    for (let i = 0; i < display.length; i += 1) {
      const item = display[i] as LayerStripItem;
      const isTopmost = i === 0;
      const isBottommost = i === display.length - 1;
      const tile = this.buildTile(item, isTopmost, isBottommost, display.length);
      this.track.appendChild(tile);
      if (renderThumbnail !== undefined) {
        const canvas = tile.querySelector<HTMLCanvasElement>(".layer-tile-thumb");
        if (canvas !== null) renderThumbnail(item.id, canvas);
      }
    }
  }

  private buildAddTile(): HTMLElement {
    const button = document.createElement("button");
    button.className = "layer-strip-add";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = NEW_PAGE_SVG;
    button.appendChild(icon);
    button.setAttribute("aria-label", plainText(TEXT.add));
    button.addEventListener("click", () => this.handlers.onAdd());
    return button;
  }

  private buildTile(item: LayerStripItem, isTopmost: boolean, isBottommost: boolean, count: number): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "layer-tile";
    tile.classList.toggle("is-active", item.active);

    const select = document.createElement("button");
    select.className = "layer-tile-select";
    select.setAttribute("aria-label", plainText(TEXT.select));
    const thumb = document.createElement("canvas");
    thumb.className = "layer-tile-thumb";
    select.appendChild(thumb);
    select.addEventListener("click", () => this.handlers.onSelect(item.id));
    tile.appendChild(select);

    const controls = document.createElement("div");
    controls.className = "layer-tile-controls";

    const eye = document.createElement("button");
    eye.className = "layer-tile-eye";
    eye.innerHTML = item.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG;
    eye.classList.toggle("is-off", !item.visible);
    eye.setAttribute("aria-label", plainText(item.visible ? TEXT.hide : TEXT.show));
    eye.addEventListener("click", () => this.handlers.onToggleVisible(item.id));
    controls.appendChild(eye);

    // 上下の矢印は選ばれている札にだけ出す(選んでいない札を動かすのは操作として迷う)。
    if (item.active) {
      const up = document.createElement("button");
      up.className = "layer-tile-up";
      up.innerHTML = CHEVRON_UP_SVG;
      up.setAttribute("aria-label", plainText(TEXT.up));
      // 端(一番上)では押しても意味が無い。「戻る/進む」と同じく、disabled + 薄い見た目で
      // 実際に押せなくする(押せるのに何も起きない、を作らない)。
      up.disabled = isTopmost;
      up.classList.toggle("is-dim", isTopmost);
      up.addEventListener("click", () => this.handlers.onMove(item.id, "up"));
      controls.appendChild(up);

      const down = document.createElement("button");
      down.className = "layer-tile-down";
      down.innerHTML = CHEVRON_DOWN_SVG;
      down.setAttribute("aria-label", plainText(TEXT.down));
      down.disabled = isBottommost;
      down.classList.toggle("is-dim", isBottommost);
      down.addEventListener("click", () => this.handlers.onMove(item.id, "down"));
      controls.appendChild(down);
    }

    tile.appendChild(controls);

    // 「けす」も選ばれている札にだけ出す。最後の 1 枚は消せない(Surface.removeLayer と同じ条件)。
    if (item.active) {
      const remove = document.createElement("button");
      remove.className = "layer-tile-remove";
      remove.appendChild(renderRuby(TEXT.remove));
      remove.disabled = count <= 1;
      remove.classList.toggle("is-dim", count <= 1);
      remove.addEventListener("click", () => this.handlers.onRemove(item.id));
      tile.appendChild(remove);
    }

    return tile;
  }
}
