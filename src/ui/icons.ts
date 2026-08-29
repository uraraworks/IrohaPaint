// ツールバー以外の UI アイコン。
// 規格は道具アイコン(src/core/tools.ts)と揃える:
//   32x32 / 線は #3d3730・太さ 2 / 角丸 / 面は彩度を落としたクレヨン色
const SPEAKER = `<path d="M7 13h5l6-5v16l-6-5H7z" fill="#f3c64b" stroke="#3d3730" stroke-width="2"
  stroke-linejoin="round"/>`;

export const SOUND_ON_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  ${SPEAKER}
  <path d="M21 12.5a6 6 0 0 1 0 7" fill="none" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
  <path d="M24.5 9a11 11 0 0 1 0 14" fill="none" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const SOUND_OFF_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  ${SPEAKER}
  <path d="M21 12.5l7 7M28 12.5l-7 7" fill="none" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** ゴミ箱。「捨てる」ボタンと「ゴミ箱」タブで使う。 */
export const TRASH_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path d="M11 7l1-2h8l1 2" fill="none" stroke="#3d3730" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"/>
  <rect x="6" y="7" width="20" height="4" rx="2" fill="#f6a5b8" stroke="#3d3730" stroke-width="2"/>
  <path d="M8.5 11h15l-1.5 14a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2z" fill="#fffdf7" stroke="#3d3730"
    stroke-width="2" stroke-linejoin="round"/>
  <path d="M13 15v8M19 15v8" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** 取り戻す。ゴミ箱から戻す動きなので、戻る矢印に紙を添える。 */
export const RESTORE_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <rect x="13" y="6" width="14" height="18" rx="2" fill="#8cc152" stroke="#3d3730" stroke-width="2"/>
  <path d="M11 13H6M9 9l-4 4 4 4" fill="none" stroke="#3d3730" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** 閉じる。 */
export const CLOSE_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path d="M9 9l14 14M23 9L9 23" fill="none" stroke="#3d3730" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/** あたらしく描く(白い紙 + プラス)。 */
export const NEW_PAGE_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <rect x="7" y="4" width="18" height="24" rx="3" fill="#fffdf7" stroke="#3d3730" stroke-width="2"/>
  <path d="M16 11v10M11 16h10" fill="none" stroke="#4aa3df" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/** 履歴(前に戻す)。時計に反時計回りの矢印。 */
export const HISTORY_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="17" cy="17" r="10" fill="#f3c64b" stroke="#3d3730" stroke-width="2"/>
  <path d="M17 11v6l4 3" fill="none" stroke="#3d3730" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round"/>
  <path d="M7 12a11 11 0 0 1 3-4" fill="none" stroke="#3d3730" stroke-width="2.5"
    stroke-linecap="round"/>
  <path d="M5 6v5h5" fill="none" stroke="#3d3730" stroke-width="2.5" stroke-linecap="round"
    stroke-linejoin="round"/>
</svg>`;

/** ぜんぶ見る(等倍に戻す)。四隅の角で「画面に収める」を表す。 */
export const FIT_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="#3d3730"
  stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 12V6h6M20 6h6v6M26 20v6h-6M12 26H6v-6"/>
</svg>`;
