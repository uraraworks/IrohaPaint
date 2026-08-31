// 下敷き(マス)の種類。ツールバーの「マス」から選ぶ。
//
// 方眼もビーズもドット絵も「マス目の上に描く」という同じ系統なので、道具を増やさず
// 1 つのサブメニューにまとめる。
import { BEAD_GRID, DOT_GRID, type CellGrid } from "./model.ts";
import type { LabelPart } from "./tools.ts";

export type GridMode = "off" | "grid" | "beads" | "dot" | "photo";

export interface GridModeDef {
  id: GridMode;
  label: LabelPart[];
  iconSvg: string;
  /**
   * マスに吸着して置くモードなら、その格子。null なら自由に描ける。
   * 吸着するモードでは太さもペン先も効かない(1 マス = 1 個なので意味を持たない)。
   */
  cells: CellGrid | null;
}

export const GRID_MODES: Readonly<Record<GridMode, GridModeDef>> = {
  // 既定。ふつうの白紙。
  off: {
    id: "off",
    label: [{ base: "なし" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M9 23L23 9" stroke="#3d3730" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    cells: null,
  },
  // 下敷きの方眼。絵はマスに吸着しない(あくまで目安)。
  grid: {
    id: "grid",
    label: [{ base: "方眼", ruby: "ほうがん" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <path d="M12.3 5v22M19.6 5v22M5 12.3h22M5 19.6h22" stroke="#3d3730" stroke-width="1.6"
        opacity="0.55"/>
    </svg>`,
    cells: null,
  },
  // アイロンビーズ。1 マス = 1 ビーズで、実物を並べるための図案になる。
  beads: {
    id: "beads",
    label: [{ base: "ビーズ" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="4" width="24" height="24" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <circle cx="11" cy="11" r="3.4" fill="#e2544a" stroke="#3d3730" stroke-width="1.6"/>
      <circle cx="21" cy="11" r="3.4" fill="#f3c64b" stroke="#3d3730" stroke-width="1.6"/>
      <circle cx="11" cy="21" r="3.4" fill="#4aa3df" stroke="#3d3730" stroke-width="1.6"/>
      <circle cx="21" cy="21" r="3.4" fill="#8cc152" stroke="#3d3730" stroke-width="1.6"/>
    </svg>`,
    cells: BEAD_GRID,
  },
  // ドット絵。ビーズと操作はまったく同じで、マスが倍細かく、1 マスが四角のベタ塗り。
  // 隣のマスと隙間なく繋がるので、拡大しても輪郭がはっきりしたドット絵になる。
  dot: {
    id: "dot",
    label: [{ base: "ドット" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="4" width="24" height="24" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <rect x="7" y="7" width="6" height="6" fill="#e2544a"/>
      <rect x="19" y="7" width="6" height="6" fill="#f3c64b"/>
      <rect x="7" y="19" width="6" height="6" fill="#4aa3df"/>
      <rect x="19" y="19" width="6" height="6" fill="#8cc152"/>
      <rect x="13" y="13" width="6" height="6" fill="#3d3730"/>
    </svg>`,
    cells: DOT_GRID,
  },
  // 取り込んだ写真を下敷きにして、その上からなぞって描く。
  // マス目と違って自由な太さ・ペン先のまま描けるので snap は false。
  photo: {
    id: "photo",
    label: [{ base: "写真", ruby: "しゃしん" }],
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="22" height="22" rx="3" fill="#fffdf7" stroke="#3d3730"
        stroke-width="2"/>
      <circle cx="20" cy="12" r="3" fill="#f3c64b" stroke="#3d3730" stroke-width="1.6"/>
      <path d="M7 23L13 15L17 19L21 13L26 23Z" fill="#8cc152" stroke="#3d3730" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`,
    cells: null,
  },
};

export const GRID_MODE_ORDER: readonly GridMode[] = ["off", "grid", "beads", "dot", "photo"];

/** マスに吸着するモードか。 */
export function snapsToCells(mode: GridMode): boolean {
  return GRID_MODES[mode].cells !== null;
}

export function isGridMode(value: unknown): value is GridMode {
  return typeof value === "string" && value in GRID_MODES;
}
