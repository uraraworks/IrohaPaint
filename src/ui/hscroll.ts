// 横スクロールする帯の共通部品。ツールバーと下敷きの帯(underlay-strip)で使う。
//
// 仕込むのは3つ:
//   (a) 左右ボタンを押すと一定量スムーススクロール
//   (b) 端に着いたらその側のボタンを隠す(押せるのに何も起きないボタンを作らない)
//   (c) マウスのドラッグで横に流せる(指は端末側のスクロールに任せる)

export interface HScrollArrows {
  left: HTMLElement;
  right: HTMLElement;
}

export interface HScrollControl {
  /** 端の判定・矢印の表示を再計算する。内容が増減した直後などに呼ぶ。 */
  sync: () => void;
}

/**
 * track(横スクロールする要素)と左右の矢印ボタンに、送り・端の表示切り替え・
 * マウスドラッグを仕込む。矢印ボタンの生成そのものは呼び出し側が行う
 * (ツールバーと帯とで見た目の規格が違うため)。
 */
export function installHScroll(track: HTMLElement, arrows: HScrollArrows): HScrollControl {
  const sync = (): void => {
    const { scrollLeft, scrollWidth, clientWidth } = track;
    const max = scrollWidth - clientWidth;
    arrows.left.classList.toggle("is-visible", scrollLeft > 2);
    arrows.right.classList.toggle("is-visible", scrollLeft < max - 2);
  };

  arrows.left.addEventListener("click", () => {
    // 1 回で 8 割ぶん送る。全部入れ替わると今どこにいるか分からなくなる。
    const step = track.clientWidth * 0.8;
    track.scrollBy({ left: -step, behavior: "smooth" });
  });
  arrows.right.addEventListener("click", () => {
    const step = track.clientWidth * 0.8;
    track.scrollBy({ left: step, behavior: "smooth" });
  });

  track.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
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
