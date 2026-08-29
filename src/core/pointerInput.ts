// 入力。Pointer Events でマウス / 指 / ペンを 1 本の経路にまとめる。
//
// このアプリは *タッチが母語で、マウスが後追い* (WebPaint98 とは逆向き)。
// したがって:
//   - ホバー・右クリックに機能を置かない
//   - 指 1 本は常に「描く」。触れた瞬間に線が出る(長押し待ちを挟まない)
//   - 指 2 本は「見る操作」(ピンチ拡大・移動)。動かさずに離せば「もどる」
//   - 2 本目が触れた時点で、描きかけの線は無かったことにする
//     (写真アプリの感覚でピンチした子が、意図しない線を残さないため)

export interface CanvasPoint {
  x: number;
  y: number;
  /** イベント時刻(ms)。線の速さ = 太さの計算に使う。 */
  time: number;
  /**
   * 筆圧(0..1)。スタイラスでのみ意味を持つ。
   * マウス / 指は押下中つねに 0.5 を返すので、そのまま渡して brush.ts 側で判断させる。
   */
  pressure: number | undefined;
}

export interface GestureChange {
  /** 直前フレームからの倍率。 */
  scaleFactor: number;
  /** 2 本指の中点の移動量(画面 px)。 */
  dx: number;
  dy: number;
  /** 中点(画面座標)。ピンチの中心。 */
  centerX: number;
  centerY: number;
}

export interface PointerHandlers {
  onDown: (point: CanvasPoint) => void;
  onMove: (point: CanvasPoint) => void;
  onUp: () => void;
  /** 2 本目の指が触れた。描きかけを取り消す。 */
  onGestureStart?: () => void;
  onGestureChange?: (change: GestureChange) => void;
  onGestureEnd?: () => void;
  /** 2 本指タップ = もどる(ibisPaint / Procreate と同じ作法)。 */
  onTwoFingerTap?: () => void;
}

/** 2 本指タップと認める最大時間。これより長ければ「置いただけ」。 */
const TWO_FINGER_TAP_MS = 500;
/** これ以上動いたらタップではなくピンチ/移動とみなす(画面 px)。 */
const TAP_SLOP_PX = 16;

export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  time = 0,
  pressure: number | undefined = undefined,
): CanvasPoint {
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0, time, pressure };
  return {
    x: ((clientX - rect.left) / rect.width) * canvasWidth,
    y: ((clientY - rect.top) / rect.height) * canvasHeight,
    time,
    pressure,
  };
}

interface TouchState {
  x: number;
  y: number;
}

function distance(a: TouchState, b: TouchState): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 戻り値は購読解除関数。 */
export function installPointerInput(canvas: HTMLCanvasElement, handlers: PointerHandlers): () => void {
  let drawPointerId: number | null = null;
  const touches = new Map<number, TouchState>();
  let gestureActive = false;
  let lastDistance = 0;
  let lastCenter: TouchState = { x: 0, y: 0 };
  let multiStartedAt = 0;
  let maxTouchCount = 0;
  let movedPx = 0;
  /** ジェスチャ後、全部の指が離れるまでは描き始めない(残った 1 本で線が出る事故を防ぐ)。 */
  let suppressDraw = false;

  const pointOf = (event: {
    clientX: number;
    clientY: number;
    timeStamp?: number;
    pressure?: number;
    pointerType?: string;
  }): CanvasPoint =>
    toCanvasPoint(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height,
      event.timeStamp ?? 0,
      // 本物の筆圧はペンでしか取れない。指 / マウスの値は使わない。
      event.pointerType === "pen" ? event.pressure : undefined,
    );

  const centerOf = (a: TouchState, b: TouchState): TouchState => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const twoTouches = (): [TouchState, TouchState] | null => {
    const list = [...touches.values()];
    const first = list[0];
    const second = list[1];
    if (first === undefined || second === undefined) return null;
    return [first, second];
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      if (touches.size === 0) {
        multiStartedAt = event.timeStamp;
        maxTouchCount = 0;
        movedPx = 0;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size > maxTouchCount) maxTouchCount = touches.size;

      const pair = twoTouches();
      if (touches.size === 2 && pair !== null) {
        // 見る操作へ切り替える。描きかけは捨てる。
        gestureActive = true;
        suppressDraw = true;
        lastDistance = distance(pair[0], pair[1]);
        lastCenter = centerOf(pair[0], pair[1]);
        if (drawPointerId !== null) {
          drawPointerId = null;
          handlers.onGestureStart?.();
        } else {
          handlers.onGestureStart?.();
        }
        return;
      }
    }

    if (drawPointerId !== null || suppressDraw || gestureActive) return;
    drawPointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    handlers.onDown(pointOf(event));
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch" && touches.has(event.pointerId)) {
      const previous = touches.get(event.pointerId);
      if (previous !== undefined) {
        movedPx += Math.hypot(event.clientX - previous.x, event.clientY - previous.y);
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pair = twoTouches();
      if (gestureActive && pair !== null) {
        event.preventDefault();
        const nextDistance = distance(pair[0], pair[1]);
        const nextCenter = centerOf(pair[0], pair[1]);
        handlers.onGestureChange?.({
          scaleFactor: lastDistance > 0 ? nextDistance / lastDistance : 1,
          dx: nextCenter.x - lastCenter.x,
          dy: nextCenter.y - lastCenter.y,
          centerX: nextCenter.x,
          centerY: nextCenter.y,
        });
        lastDistance = nextDistance;
        lastCenter = nextCenter;
        return;
      }
    }

    if (event.pointerId !== drawPointerId) return;
    event.preventDefault();
    // 高頻度ポインタ(120Hz の iPad 等)では中間座標がまとめて届く。使うと速い線がカクつかない。
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    if (coalesced.length > 0) for (const sample of coalesced) handlers.onMove(pointOf(sample));
    else handlers.onMove(pointOf(event));
  };

  const finish = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      touches.delete(event.pointerId);
      if (touches.size < 2 && gestureActive) {
        gestureActive = false;
        handlers.onGestureEnd?.();
      }
      if (touches.size === 0) {
        suppressDraw = false;
        const quick = event.timeStamp - multiStartedAt <= TWO_FINGER_TAP_MS;
        const tapped = maxTouchCount === 2 && quick && movedPx <= TAP_SLOP_PX;
        maxTouchCount = 0;
        if (tapped) {
          drawPointerId = null;
          handlers.onTwoFingerTap?.();
          return;
        }
      }
    }
    if (event.pointerId !== drawPointerId) return;
    drawPointerId = null;
    handlers.onUp();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  // iOS Safari は指を置き続けると選択・拡大鏡が出る。これを黙らせる。
  const swallow = (event: Event): void => event.preventDefault();
  canvas.addEventListener("contextmenu", swallow);

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", finish);
    canvas.removeEventListener("pointercancel", finish);
    canvas.removeEventListener("contextmenu", swallow);
  };
}
