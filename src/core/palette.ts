// クレヨン 12 色。原色をそのまま使うと画面が騒がしくなるので彩度を少し落とす
// (プロト仕様書§6「クレヨン色」)。並び順は色相順にして探しやすくする。
export const CRAYON_COLORS: readonly string[] = [
  "#3d3730", // くろ
  "#8a6a4f", // ちゃいろ
  "#e2544a", // あか
  "#f2884b", // だいだい
  "#f3c64b", // きいろ
  "#8cc152", // きみどり
  "#3aa76d", // みどり
  "#4aa3df", // みずいろ
  "#3f6fc4", // あお
  "#8e6fc4", // むらさき
  "#f291b8", // ももいろ
  "#ffffff", // しろ
];

/**
 * アイロンビーズの色。実物の基本セット(パーラー / ハマビーズ等)にある色へ寄せてある。
 *
 * クレヨン 12 色のまま図案を描くと、**手元に無い色で描いてしまい再現できない**。
 * 「画面で描いたものが手元の立体になる」ことが狙いなので、
 * ビーズモードのときはこちらのパレットに差し替える。
 * 並びは色相順(白・肌・茶・灰・黒は最後にまとめる)。
 */
export const BEAD_COLORS: readonly string[] = [
  "#e4322b", // あか
  "#a32020", // あかちゃ
  "#ff8a00", // オレンジ
  "#ffd400", // きいろ
  "#f6ea8c", // クリーム
  "#a6ce39", // きみどり
  "#46b04a", // みどり
  "#1e7a3c", // ふかみどり
  "#62c3ea", // みずいろ
  "#1f6fd0", // あお
  "#1b3f8b", // こんいろ
  "#8b5ca8", // むらさき
  "#c3a3dc", // ふじいろ
  "#e9538a", // こいピンク
  "#ff8fb1", // ピンク
  "#f3c6a5", // はだいろ
  "#c08b4e", // うすちゃ
  "#7a4b25", // ちゃいろ
  "#ffffff", // しろ
  "#d9d9d9", // うすはいいろ
  "#9aa0a6", // はいいろ
  "#545a60", // こいはいいろ
  "#1b1b1b", // くろ
  "#00a3a3", // ターコイズ
];

/** いちばん近いビーズ色を返す。ビーズモードへ入ったとき、選んでいた色を寄せるのに使う。 */
export function nearestBeadColor(hex: string): string {
  const parse = (value: string): [number, number, number] => [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
  const [r, g, b] = parse(hex);
  let best = BEAD_COLORS[0] ?? "#1b1b1b";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of BEAD_COLORS) {
    const [cr, cg, cb] = parse(candidate);
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * ふでの太さ 5 段階(キャンバス実解像度 1748px 幅に対する px)。
 *
 * 細い側の 3 と 6 は、画面に収めて表示すると 1〜3px 相当にしかならない。
 * 拡大して描き込むときのための段で、等倍のまま使うものではない。
 */
export const PEN_SIZES: readonly number[] = [3, 6, 10, 26, 60];

/**
 * 消しゴムの太さ 3 段階。ふでより一回り大きい。
 * 消す動作は「細かく直す」より「広く消す」が多く、
 * ふでと同じ細さだと塗りつぶしを消すのに時間がかかりすぎる。
 */
export const ERASER_SIZES: readonly number[] = [26, 70, 160];
