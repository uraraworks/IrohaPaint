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
