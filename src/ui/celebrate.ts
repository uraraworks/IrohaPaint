// 「かんせい！」の祝福演出。紙吹雪程度に留める(仕様書§4)。
// canvas 1 枚に描いて 1.6 秒で自分を消す。DOM を汚さない。

const COLORS = ["#f26d5b", "#f2b134", "#7ac74f", "#4aa3df", "#b07cc6", "#f291b8"];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  color: string;
}

export function celebrate(parent: HTMLElement): void {
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  const width = parent.clientWidth;
  const height = parent.clientHeight;
  canvas.width = width;
  canvas.height = height;
  parent.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    canvas.remove();
    return;
  }

  const pieces: Piece[] = Array.from({ length: 90 }, () => ({
    x: width / 2 + (Math.random() - 0.5) * width * 0.6,
    y: height * 0.45 + (Math.random() - 0.5) * 80,
    vx: (Math.random() - 0.5) * 12,
    vy: -Math.random() * 14 - 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#f2b134",
  }));

  const start = performance.now();
  const step = (now: number): void => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, width, height);
    for (const piece of pieces) {
      piece.vy += 0.45; // 重力
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.rot += piece.vr;
      ctx.save();
      ctx.translate(piece.x, piece.y);
      ctx.rotate(piece.rot);
      ctx.fillStyle = piece.color;
      ctx.fillRect(-7, -4, 14, 8);
      ctx.restore();
    }
    canvas.style.opacity = elapsed > 1200 ? String(1 - (elapsed - 1200) / 400) : "1";
    if (elapsed < 1600) requestAnimationFrame(step);
    else canvas.remove();
  };
  requestAnimationFrame(step);
}
