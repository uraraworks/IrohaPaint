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

/** ふでの太さ 3 段階(キャンバス実解像度 1748px 幅に対する px)。 */
export const PEN_SIZES: readonly number[] = [10, 26, 60];
export const ERASER_SIZE = 70;
