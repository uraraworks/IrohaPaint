// 道具の定義と、宝箱による解放条件。
//
// プロト仕様書§4:
//   起動直後 … ふで / いろ / けす / もどる / かんせい!
//   宝箱     … 描いた量に応じて 2 回。解放は「描く行為の自然な副産物」に限る。
// Phase 1 の「道具カタログ」はこの表をそのままカタログ項目に流用できる形にしておく。

export type ToolId = "pen" | "color" | "eraser" | "undo" | "done" | "picker" | "fill";

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
  icon: string;
  /** カタログ用の説明。Phase 1 で使う。 */
  description: string;
}

/** ふりがなを外した文字列。読み上げ(aria-label)や L3 表記に使う。 */
export function plainLabel(def: ToolDef): string {
  return def.label.map((part) => part.base).join("");
}

export const TOOL_DEFS: Readonly<Record<ToolId, ToolDef>> = {
  pen: { id: "pen", label: [{ base: "筆", ruby: "ふで" }], icon: "✏️", description: "せんを かけるよ" },
  color: { id: "color", label: [{ base: "色", ruby: "いろ" }], icon: "🎨", description: "いろを えらべるよ" },
  eraser: {
    id: "eraser",
    label: [{ base: "消", ruby: "け" }, { base: "す" }],
    icon: "🧽",
    description: "かいたものを けせるよ",
  },
  undo: {
    id: "undo",
    label: [{ base: "戻", ruby: "もど" }, { base: "る" }],
    icon: "↩️",
    description: "ひとつ まえに もどせるよ",
  },
  done: {
    id: "done",
    label: [{ base: "完成", ruby: "かんせい" }, { base: "！" }],
    icon: "🎉",
    description: "えを ほぞんできるよ",
  },
  // カタカナ語はふりがな不要。無理に振ると逆に読みにくい。
  picker: { id: "picker", label: [{ base: "スポイト" }], icon: "💧", description: "がめんの いろを すいとって つかえるよ" },
  fill: {
    id: "fill",
    label: [{ base: "塗", ruby: "ぬ" }, { base: "る" }],
    icon: "🪣",
    description: "かこんだ なかを いっきに ぬれるよ",
  },
};

/** 起動直後にツールバーにあるもの。 */
export const INITIAL_TOOLS: readonly ToolId[] = ["pen", "color", "eraser", "undo", "done"];

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
