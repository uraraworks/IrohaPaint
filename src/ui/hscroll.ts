// 横スクロールする帯の共通部品。ツールバーと下敷きの帯(underlay-strip)で使う。
//
// 仕込むのは3つ:
//   (a) 左右ボタンを押すと一定量スムーススクロール(ボタンを渡した場合のみ)
//   (b) 端に着いたらその側のボタンを隠す・端をぼかす(押せるのに何も起きないボタンを作らない)
//   (c) マウスのドラッグで横に流せる(指は端末側のスクロールに任せる)

export interface HScrollArrows {
  left: HTMLElement;
  right: HTMLElement;
}

export interface HScrollControl {
  /** 端の判定・矢印の表示を再計算する。内容が増減した直後などに呼ぶ。 */
  sync: () => void;
}

export interface HScrollRowResult {
  /** 実際に横スクロールする中身。呼び出し側はここへボタン等を append する。 */
  track: HTMLElement;
  control: HScrollControl;
}

/**
 * パネル内の行(ペン先・太さ・紙・マス・濃さ)を横スクロールにする共通部品。
 * ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
 * 縦に伸び、狭い画面では選ぶために絵が見えなくなる。
 *
 * 送りボタンは付けない。溢れている行が複数あると送りボタンが縦に並び、繰り返しの
 * 要素が不具合のように見える。パネルの行は隠れている量が少ない(4 個中 3 個が
 * 見えている)ので、端をぼかして切れているものを覗かせれば「まだ先がある」は伝わる。
 * ツールバーは 11 個中 4 個しか見えず次が想像できないので、あちらは送りボタンを残す。
 * ぼかし自体は CSS 側(.hscroll-track の mask-image、is-overflow-left/right で切り替え)。
 * ドラッグでのスクロールは installHScroll にそのまま任せる。
 */
export function makeHScrollPanelRow(wrapper: HTMLElement): HScrollRowResult {
  const track = document.createElement("div");
  track.className = "hscroll-track";
  wrapper.append(track);
  const control = installHScroll(track);
  return { track, control };
}

/**
 * track(横スクロールする要素)に、端の表示切り替え・マウスドラッグを仕込む。
 * 左右の矢印ボタンは省略可能(パネル内の行は付けない。送りボタンの生成そのものは
 * 呼び出し側が行う。ツールバーと帯とで見た目の規格が違うため)。
 */
export function installHScroll(track: HTMLElement, arrows?: HScrollArrows): HScrollControl {
  const sync = (): void => {
    const { scrollLeft, scrollWidth, clientWidth } = track;
    const max = scrollWidth - clientWidth;
    const overflowLeft = scrollLeft > 2;
    const overflowRight = scrollLeft < max - 2;
    arrows?.left.classList.toggle("is-visible", overflowLeft);
    arrows?.right.classList.toggle("is-visible", overflowRight);
    // 送りボタンを持たない行(パネル内の行)向け: 端が隠れている側だけぼかす。
    track.classList.toggle("is-overflow-left", overflowLeft);
    track.classList.toggle("is-overflow-right", overflowRight);
  };

  arrows?.left.addEventListener("click", () => {
    // 1 回で 8 割ぶん送る。全部入れ替わると今どこにいるか分からなくなる。
    const step = track.clientWidth * 0.8;
    track.scrollBy({ left: -step, behavior: "smooth" });
  });
  arrows?.right.addEventListener("click", () => {
    const step = track.clientWidth * 0.8;
    track.scrollBy({ left: step, behavior: "smooth" });
  });

  track.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  // パネル内の行は開くまで display: none で幅 0 のまま作られる(中身を足した直後は
  // まだ画面に出ていない)。ResizeObserver で実際にサイズが変わった瞬間(パネルが
  // 開いた瞬間・中身が増減した瞬間)を捉えてそのつど計算し直せば、呼び出し側が
  // 都度 sync() を呼ばなくても常に正しい状態になる(Panel の position() と同じ考え方)。
  new ResizeObserver(sync).observe(track);
  installHScrollDrag(track);
  sync();

  return { sync };
}

/**
 * マウスでもドラッグで流せるようにする(指は端末が勝手にスクロールしてくれる)。
 * 少しでも動かしたらボタンの click は打ち消す。
 * ドラッグの終わりにボタンが反応すると、道具(や下敷き)が勝手に切り替わってしまう。
 */
function installHScrollDrag(track: HTMLElement): void {
  let startX = 0;
  let startScroll = 0;
  let pointerId: number | null = null;
  let moved = false;

  track.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return; // 指は端末側のスクロールに任せる
    pointerId = event.pointerId;
    startX = event.clientX;
    startScroll = track.scrollLeft;
    moved = false;
  });
  track.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    if (Math.abs(dx) > 4) moved = true;
    if (moved) track.scrollLeft = startScroll - dx;
  });
  const end = (): void => {
    pointerId = null;
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  // 捕捉フェーズで止める。各ボタンの click より先に握りつぶす必要がある。
  track.addEventListener(
    "click",
    (event) => {
      if (!moved) return;
      event.stopPropagation();
      event.preventDefault();
      moved = false;
    },
    true,
  );
}
