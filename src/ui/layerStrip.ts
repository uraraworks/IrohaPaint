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
  /**
   * ドラッグでの並べ替え。toIndex は Surface.moveLayer と同じ約束(0 が一番下)。
   * 呼び出し側で実際に並びが変わったときだけ呼ぶ(掴んで戻しただけなら呼ばない)。
   */
  onReorder(id: string, toIndex: number): void;
  onAdd(): void;
  onRemove(id: string): void;
  /**
   * ドラッグの持ち上げ/落としの合図。効果音はここでは鳴らさず、呼び出し側(main.ts)に
   * 任せる(このモジュールが Surface だけでなく sound も知らずに済むようにするため)。
   * onDragEnd は並べ替えが成立したかに関わらず、指(マウス)を離すたびに1回呼ぶ。
   */
  onDragLift(): void;
  onDragEnd(): void;
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

/** 指の長押し待ち。長押しが確定する前に動いたらスクロールとみなして諦める(マウスも同じ枠に間借りさせる)。 */
interface PendingLift {
  pointerId: number;
  tile: HTMLElement;
  id: string;
  startX: number;
  startY: number;
  /** マウスは閾値越えで即持ち上げるのでタイマーを持たない(null)。指は 400ms のタイマー。 */
  timer: number | null;
}

/** 持ち上げてから、まだ落ちていない(並べ替え中の)状態。 */
interface DragState {
  pointerId: number;
  id: string;
  tile: HTMLElement;
  /** 動かしている札を除く、他の札の元の並び(先頭が一番上)。ドラッグ中も並び順自体は変わらない。 */
  others: HTMLElement[];
  /** 動かしている札の代わりに隙間を見せる、見た目だけの空札。 */
  placeholder: HTMLElement;
  /** 掴んだ位置と札の上端との差。指(マウス)にそのまま追従させるために使う。 */
  offsetY: number;
  /** others の中で、動かしている札が元々あった位置(0が一番上)。 */
  originalIndex: number;
  lastPointerY: number;
  autoScrollRaf: number | null;
}

export class LayerStrip {
  readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private readonly handlers: LayerStripHandlers;
  private pendingLift: PendingLift | null = null;
  private dragState: DragState | null = null;
  private suppressNextClick = false;

  // 指は 400ms 程度の長押しで持ち上げる(帯の縦スクロールと縦ドラッグが同じ指の動きなので、
  // 「動かさずに待つ」ことで区別する)。マウスは installHScrollDrag と同じ 4px 閾値。
  private static readonly LONG_PRESS_MS = 400;
  private static readonly MOUSE_DRAG_THRESHOLD = 4;
  // 長押し確定前にこれ以上動いたらスクロールの意思とみなす。
  private static readonly TOUCH_CANCEL_THRESHOLD = 6;
  // 帯の上下端からこの距離まで来たら自動スクロールを始める。
  private static readonly AUTOSCROLL_EDGE = 48;
  // 自動スクロールは「ゆっくり」が要件なので、1フレームあたりの移動量を控えめにする。
  private static readonly AUTOSCROLL_SPEED = 4;

  constructor(parent: HTMLElement, handlers: LayerStripHandlers) {
    this.handlers = handlers;
    this.element = document.createElement("div");
    this.element.className = "layer-strip";
    this.track = document.createElement("div");
    this.track.className = "layer-strip-track";
    this.element.appendChild(this.track);
    parent.appendChild(this.element);
    this.installOverflowFade();
    this.installDragReorder();
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
    tile.dataset.layerId = item.id; // ドラッグ並べ替え(installDragReorder)がここから id を拾う

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

  // --- ドラッグ並べ替え -----------------------------------------------------
  //
  // installHScrollDrag(hscroll.ts)と作法を揃える: マウスは 4px 動いたら開始、
  // ドラッグ後の誤クリックは捕捉フェーズで握りつぶす。加えてこの帯は縦スクロールする
  // ので、指の場合だけ「動かさずに 400ms 待つ」長押しで持ち上げを確定させ、
  // それより前に動いたらスクロールの意思とみなして諦める(区別する必要が無いマウスは
  // 待たずに閾値越えでそのまま持ち上げる)。
  //
  // 帯そのもの(track)にイベントを1組だけ仕込む(sync() のたびに札は作り直されるため、
  // 札1枚ごとに付け外しするより委譲の方が安全)。

  private installDragReorder(): void {
    this.track.addEventListener("pointerdown", (event) => this.onTrackPointerDown(event));
    this.track.addEventListener("pointermove", (event) => this.onTrackPointerMove(event));
    this.track.addEventListener("pointerup", (event) => this.onTrackPointerUp(event));
    this.track.addEventListener("pointercancel", (event) => this.onTrackPointerCancel(event));
    // installHScrollDrag と同じ作法: 捕捉フェーズで先に止めないと、各ボタンや
    // .layer-tile-select の click がドラッグの直後に発火して勝手に切り替わってしまう。
    this.track.addEventListener(
      "click",
      (event) => {
        if (!this.suppressNextClick) return;
        this.suppressNextClick = false;
        event.stopPropagation();
        event.preventDefault();
      },
      true,
    );
  }

  private onTrackPointerDown(event: PointerEvent): void {
    if (this.dragState !== null || this.pendingLift !== null) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement;
    // 目・上下矢印・けすの上から始めたときはドラッグにしない(それぞれのボタン自身の
    // click をそのまま生かす)。
    if (target.closest(".layer-tile-eye, .layer-tile-up, .layer-tile-down, .layer-tile-remove") !== null) return;
    const tile = target.closest<HTMLElement>(".layer-tile");
    if (tile === null) return;
    const id = tile.dataset.layerId;
    if (id === undefined) return;

    const startX = event.clientX;
    const startY = event.clientY;
    if (event.pointerType === "mouse") {
      // マウスは「動くまで待つ」だけで、タイマーは張らない。
      this.pendingLift = { pointerId: event.pointerId, tile, id, startX, startY, timer: null };
      return;
    }

    const pointerId = event.pointerId;
    const timer = window.setTimeout(() => {
      if (this.pendingLift === null || this.pendingLift.pointerId !== pointerId) return;
      this.pendingLift = null;
      this.beginDrag(tile, id, pointerId, startX, startY);
    }, LayerStrip.LONG_PRESS_MS);
    this.pendingLift = { pointerId, tile, id, startX, startY, timer };
  }

  private onTrackPointerMove(event: PointerEvent): void {
    if (this.dragState !== null) {
      if (event.pointerId !== this.dragState.pointerId) return;
      this.updateDrag(event.clientY);
      return;
    }
    const pending = this.pendingLift;
    if (pending === null || pending.pointerId !== event.pointerId) return;
    const dist = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);

    if (pending.timer === null) {
      // マウス: 閾値を越えたその場で持ち上げる。
      if (dist > LayerStrip.MOUSE_DRAG_THRESHOLD) {
        this.pendingLift = null;
        this.beginDrag(pending.tile, pending.id, pending.pointerId, event.clientX, event.clientY);
      }
      return;
    }

    // 指: 長押しが確定する前に動いたらスクロールとみなし、持ち上げ待ちを取り消す。
    if (dist > LayerStrip.TOUCH_CANCEL_THRESHOLD) {
      window.clearTimeout(pending.timer);
      this.pendingLift = null;
    }
  }

  private onTrackPointerUp(event: PointerEvent): void {
    if (this.dragState !== null && event.pointerId === this.dragState.pointerId) {
      this.endDrag(true);
      return;
    }
    this.clearPendingLift(event.pointerId);
  }

  private onTrackPointerCancel(event: PointerEvent): void {
    // pointercancel は「落とし場所が決まらなかった」扱いにして、必ず元の位置へ戻す。
    if (this.dragState !== null && event.pointerId === this.dragState.pointerId) {
      this.endDrag(false);
      return;
    }
    this.clearPendingLift(event.pointerId);
  }

  private clearPendingLift(pointerId: number): void {
    if (this.pendingLift === null || this.pendingLift.pointerId !== pointerId) return;
    if (this.pendingLift.timer !== null) window.clearTimeout(this.pendingLift.timer);
    this.pendingLift = null;
  }

  /** 長押し(または4px閾値)が確定した瞬間。ここから札が指(マウス)に追従し始める。 */
  private beginDrag(tile: HTMLElement, id: string, pointerId: number, clientX: number, clientY: number): void {
    const rect = tile.getBoundingClientRect();
    // 動かす札を除いた、他の札の元の並び。ドラッグ中はこの並び自体は変えず、
    // placeholder(隙間)だけをこの中で動かして「入る場所」を見せる。
    const others = Array.from(this.track.querySelectorAll<HTMLElement>(".layer-tile")).filter((el) => el !== tile);
    const originalIndex = others.filter((el) => el.getBoundingClientRect().top < rect.top).length;

    const placeholder = document.createElement("div");
    placeholder.className = "layer-tile-placeholder";
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;
    tile.before(placeholder);

    // 持ち上げた札は fixed で画面(ビューポート)基準に浮かせる。track は overflow-y: auto +
    // mask-image で切り取っているので、track の内側に留めたままだと帯からはみ出た瞬間に
    // 消えてしまう(ぼかしで隠れる・スクロール領域外はクリップされる)。fixed にすればその
    // 影響を受けない(この帯の先祖に transform/filter は無く、fixed の基準はビューポートの
    // ままになることを確認済み)。
    tile.classList.add("is-dragging");
    tile.style.position = "fixed";
    tile.style.left = `${rect.left}px`;
    tile.style.top = `${rect.top}px`;
    tile.style.width = `${rect.width}px`;

    // 持ち上げている間は帯自体をスクロールさせない(縦ドラッグと縦スクロールの手の
    // 動きが同じなので、ここで役割を切り替える)。pointer capture で以降のイベントは
    // track に固定して受け続ける。
    this.track.style.touchAction = "none";
    this.track.setPointerCapture(pointerId);

    this.dragState = {
      pointerId,
      id,
      tile,
      others,
      placeholder,
      offsetY: clientY - rect.top,
      originalIndex,
      lastPointerY: clientY,
      autoScrollRaf: null,
    };
    this.suppressNextClick = true;
    this.handlers.onDragLift();
    this.updateDrag(clientY);
  }

  private updateDrag(clientY: number): void {
    const state = this.dragState;
    if (state === null) return;
    state.lastPointerY = clientY;
    state.tile.style.top = `${clientY - state.offsetY}px`;
    this.repositionPlaceholder(clientY);
    this.kickAutoScroll();
  }

  /**
   * 指(マウス)の位置から、placeholder(隙間)を差し込む場所を決め直す。
   * others は元の並び順のまま動かないので、「まだ指より下にある最初の1枚」の
   * 手前に差し込めばよい(無ければ末尾)。これで他の札が場所を空けて見える。
   */
  private repositionPlaceholder(clientY: number): void {
    const state = this.dragState;
    if (state === null) return;
    let target: HTMLElement | null = null;
    for (const el of state.others) {
      const elRect = el.getBoundingClientRect();
      if (clientY < elRect.top + elRect.height / 2) {
        target = el;
        break;
      }
    }
    this.track.insertBefore(state.placeholder, target);
  }

  /**
   * 帯の上下端に指(マウス)が近づいたら、ゆっくり自動スクロールする(8枚あると
   * 画面に収まらず、送りボタンも無いので遠くへ運べないため)。毎フレーム
   * lastPointerY を見直すので、指が動かなくてもスクロールに合わせて差し込み先を
   * 追随させ続けられる。端から離れたら自分でループを止める。
   */
  private kickAutoScroll(): void {
    const state = this.dragState;
    if (state === null || state.autoScrollRaf !== null) return;
    const step = (): void => {
      const current = this.dragState;
      if (current === null) return;
      const rect = this.track.getBoundingClientRect();
      const nearTop = current.lastPointerY - rect.top < LayerStrip.AUTOSCROLL_EDGE;
      const nearBottom = rect.bottom - current.lastPointerY < LayerStrip.AUTOSCROLL_EDGE;
      if (nearTop) this.track.scrollTop -= LayerStrip.AUTOSCROLL_SPEED;
      else if (nearBottom) this.track.scrollTop += LayerStrip.AUTOSCROLL_SPEED;
      if (nearTop || nearBottom) {
        this.repositionPlaceholder(current.lastPointerY);
        current.autoScrollRaf = requestAnimationFrame(step);
      } else {
        current.autoScrollRaf = null;
      }
    };
    state.autoScrollRaf = requestAnimationFrame(step);
  }

  /**
   * 指(マウス)を離した/離れた瞬間。commit=false(pointercancel)は必ず元の位置へ戻す
   * ("取り消し"は常に安全側、何もしないを選ぶ)。
   */
  private endDrag(commit: boolean): void {
    const state = this.dragState;
    if (state === null) return;
    this.dragState = null;
    if (state.autoScrollRaf !== null) cancelAnimationFrame(state.autoScrollRaf);
    this.track.releasePointerCapture(state.pointerId);
    this.track.style.touchAction = "";

    // 片付ける(placeholder を消す・tile を静的な見た目へ戻す)より前に、
    // 差し込み先(others の中で placeholder が何番目か)を読み取っておく。
    let finalIndexFromTop = state.originalIndex;
    if (commit) {
      finalIndexFromTop = state.others.filter(
        (el) => (el.compareDocumentPosition(state.placeholder) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      ).length;
    }

    state.placeholder.remove();
    state.tile.classList.remove("is-dragging");
    state.tile.style.position = "";
    state.tile.style.left = "";
    state.tile.style.top = "";
    state.tile.style.width = "";

    this.handlers.onDragEnd();

    // ドラッグ後の click 握りつぶしは「直後の1回だけ」を狙ったものだが、pointer capture
    // 経由の pointerup だと click 自体が飛んでこない場合があり、そのままだと
    // suppressNextClick が下りずに次の(無関係な)クリックまで巻き込んで無効化してしまう
    // (実機確認で上下矢印ボタンが効かなくなる不具合として顕在化した)。次のタスクで
    // 必ず下ろして、消費されないまま残る事故を防ぐ。
    setTimeout(() => {
      this.suppressNextClick = false;
    }, 0);

    if (commit && finalIndexFromTop !== state.originalIndex) {
      // finalIndexFromTop は「上から何番目か」(0が一番上)。Surface.moveLayer の約束
      // (0が一番下)へ変換するには、全体の枚数から引いて逆順にする必要がある
      // (この帯は上が上のかさね=表示順と index の向きが逆、というこのファイル冒頭の
      // 注意点そのもの。ここを間違えると重なり順が反転する)。
      const total = state.others.length + 1;
      this.handlers.onReorder(state.id, total - 1 - finalIndexFromTop);
    }
  }
}
