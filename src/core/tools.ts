// 道具の定義と、宝箱による解放条件。
//
// プロト仕様書§4:
//   起動直後 … ふで / いろ / けす / もどる / かんせい!
//   宝箱     … 描いた量に応じて 2 回。解放は「描く行為の自然な副産物」に限る。
// Phase 1 の「道具カタログ」はこの表をそのままカタログ項目に流用できる形にしておく。

export type ToolId = "pen" | "color" | "eraser" | "undo" | "redo" | "works" | "done" | "picker" | "fill";

/**
 * ラベルの 1 かたまり。ruby があれば漢字にふりがなを振る。
 * 企画書§4.2 の表記レベル:
 *   L1 ひらがな / L2 漢字+総ルビ / L3 一般ソフト用語(ルビ無し)
 * プロトの既定は L2。L3 への切替は「ふりがなを外すだけ」で済むよう、
 * 表記を文字列ではなく *base と ruby の対* で持つ(ここが後の切替コストを決める)。
 */
export interface LabelPart {
  base: string;
  ruby?: string;
}

export interface ToolDef {
  id: ToolId;
  /** L2(漢字+総ルビ)表記。 */
  label: LabelPart[];
  /** 絵文字アイコン。iconSvg があればそちらを優先する(いまは全道具が SVG)。 */
  icon: string;
  /**
   * 自前アイコン。絵文字はプラットフォームごとに絵柄も精度も変わり
   * (消しゴムに至っては絵文字が存在せず、スポンジ🧽を当てると豆に見える)、
   * 線の太さも揃わない。全道具を同じ規格で描き起こす:
   *   32x32 / 線は #3d3730・太さ 2(矢印だけ 3)/ 角丸 / 面は彩度を落としたクレヨン色
   */
  iconSvg?: string;
  /** カタログ用の説明。Phase 1 で使う。 */
  description: string;
}

/** ふりがなを外した文字列。読み上げ(aria-label)や L3 表記に使う。 */
export function plainLabel(def: ToolDef): string {
  return def.label.map((part) => part.base).join("");
}

export const TOOL_DEFS: Readonly<Record<ToolId, ToolDef>> = {
  // 「筆」だと道具の名前になってしまう。子どもが押す理由は行為なので「描く」にする。
  pen: {
    id: "pen",
    label: [{ base: "描", ruby: "か" }, { base: "く" }],
    icon: "✏️",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-20 16 16)">
      <rect x="11" y="3" width="10" height="4" rx="1.5" fill="#f6a5b8" stroke="#3d3730" stroke-width="2"/>
      <rect x="11" y="6" width="10" height="14" fill="#f3c64b" stroke="#3d3730" stroke-width="2"/>
      <path d="M11 20h10l-5 8z" fill="#f7e6c4" stroke="#3d3730" stroke-width="2" stroke-linejoin="round"/>
      <path d="M14.2 25l3.6 0-1.8 3z" fill="#3d3730"/>
    </g></svg>`,
    description: "せんを かけるよ",
  },
  color: { id: "color", label: [{ base: "色", ruby: "いろ" }], icon: "🎨", description: "いろを えらべるよ" },
  eraser: {
    id: "eraser",
    label: [{ base: "消", ruby: "け" }, { base: "す" }],
    icon: "🧽",
    // 定番の「角を落とした消しゴム」の形。傾けて置くと鉛筆アイコンと並べても混ざらない。
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-32 16 16)">
      <rect x="8" y="5" width="16" height="22" rx="4" fill="#f6a5b8" stroke="#3d3730" stroke-width="2"/>
      <path d="M8 19h16" stroke="#3d3730" stroke-width="2"/>
      <rect x="8" y="19" width="16" height="8" rx="4" fill="#fffdf7" stroke="#3d3730" stroke-width="2"/>
    </g></svg>`,
    description: "かいたものを けせるよ",
  },
  undo: {
    id: "undo",
    label: [{ base: "戻", ruby: "もど" }, { base: "る" }],
    icon: "↩️",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="#3d3730" stroke-width="3"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 13h8a6 6 0 0 1 0 12h-5"/>
      <path d="M15 8l-5 5 5 5"/>
    </svg>`,
    description: "ひとつ まえに もどせるよ",
  },
  // 「戻る」だけだと、戻しすぎた子が取り返せない = そこで失敗が発生してしまう。
  redo: {
    id: "redo",
    label: [{ base: "進", ruby: "すす" }, { base: "む" }],
    icon: "↪️",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="#3d3730" stroke-width="3"
      stroke-linecap="round" stroke-linejoin="round">
      <g transform="translate(32 0) scale(-1 1)">
        <path d="M11 13h8a6 6 0 0 1 0 12h-5"/>
        <path d="M15 8l-5 5 5 5"/>
      </g>
    </svg>`,
    description: "もどしたのを もとに もどせるよ",
  },
  // 作品カタログ。「とっておいた絵」をメニューのように並べて選ぶ。
  works: {
    id: "works",
    label: [{ base: "作品", ruby: "さくひん" }],
    icon: "🖼️",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="7" width="16" height="14" rx="2" fill="#fffdf7" stroke="#3d3730" stroke-width="2"/>
      <rect x="9" y="11" width="16" height="14" rx="2" fill="#8cc152" stroke="#3d3730" stroke-width="2"/>
      <path d="M11 22l4-5 3 3 2-2 3 4z" fill="#fffdf7" stroke="#3d3730" stroke-width="2"
        stroke-linejoin="round"/>
    </svg>`,
    description: "とっておいた えを みられるよ",
  },
  done: {
    id: "done",
    label: [{ base: "完成", ruby: "かんせい" }, { base: "！" }],
    icon: "🎉",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12" fill="#f3c64b" stroke="#3d3730" stroke-width="2"/>
      <path d="M10 16.5l4.5 4.5L23 12" fill="none" stroke="#3d3730" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
    description: "えを ほぞんできるよ",
  },
  // カタカナ語はふりがな不要。無理に振ると逆に読みにくい。
  picker: {
    id: "picker",
    label: [{ base: "スポイト" }],
    icon: "💧",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(45 16 16)">
      <rect x="12" y="3" width="8" height="5" rx="2" fill="#f6a5b8" stroke="#3d3730" stroke-width="2"/>
      <rect x="13.5" y="8" width="5" height="10" fill="#fffdf7" stroke="#3d3730" stroke-width="2"/>
      <path d="M13.5 18h5L16 27z" fill="#4aa3df" stroke="#3d3730" stroke-width="2" stroke-linejoin="round"/>
    </g></svg>`,
    description: "がめんの いろを すいとって つかえるよ",
  },
  fill: {
    id: "fill",
    label: [{ base: "塗", ruby: "ぬ" }, { base: "る" }],
    icon: "🪣",
    iconSvg: `<svg viewBox="0 0 32 32" aria-hidden="true">
      <g transform="rotate(-20 15 18)">
        <path d="M10 6a5 4 0 0 1 10 0" fill="none" stroke="#3d3730" stroke-width="2"/>
        <path d="M7 11h16l-2.5 15h-11z" fill="#4aa3df" stroke="#3d3730" stroke-width="2" stroke-linejoin="round"/>
        <path d="M7.6 15h14.8" stroke="#3d3730" stroke-width="2"/>
      </g>
      <path d="M26 19c1.8 2.6 2.6 3.7 2.6 5a2.6 2.6 0 0 1-5.2 0c0-1.3.8-2.4 2.6-5z"
        fill="#4aa3df" stroke="#3d3730" stroke-width="2"/>
    </svg>`,
    description: "かこんだ なかを いっきに ぬれるよ",
  },
};

/** 宝箱。道具ではないが同じツールバーに並ぶので同じ規格で描く。 */
export const CHEST_ICON_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path d="M5 14a11 7 0 0 1 22 0z" fill="#e0a95f" stroke="#3d3730" stroke-width="2" stroke-linejoin="round"/>
  <rect x="5" y="14" width="22" height="12" rx="2" fill="#c08a4a" stroke="#3d3730" stroke-width="2"/>
  <rect x="13.5" y="12" width="5" height="8" rx="1.5" fill="#f3c64b" stroke="#3d3730" stroke-width="2"/>
</svg>`;

/** 起動直後にツールバーにあるもの。 */
export const INITIAL_TOOLS: readonly ToolId[] = ["pen", "color", "eraser", "undo", "redo", "works", "done"];

export interface Unlock {
  tool: ToolId;
  /** 必要ストローク数。 */
  strokes: number;
  /** 宝箱を開けたときの吹き出し(ひらがな・7 文字前後)。 */
  message: string;
}

/** 上から順に解放される。プロトは 2 回。 */
export const UNLOCKS: readonly Unlock[] = [
  { tool: "picker", strokes: 12, message: "いろが とれるよ" },
  { tool: "fill", strokes: 30, message: "いっきに ぬれるよ" },
];

/**
 * 今の描画量で新たに現れる宝箱を返す(まだ受け取っていないもののうち先頭 1 つ)。
 * 一度に複数出すと子どもが混乱するので、必ず 1 つずつ。
 */
export function nextUnlock(strokeCount: number, ownedTools: readonly ToolId[]): Unlock | null {
  for (const unlock of UNLOCKS) {
    if (ownedTools.includes(unlock.tool)) continue;
    if (strokeCount >= unlock.strokes) return unlock;
    return null; // 順番どおりに出す
  }
  return null;
}
