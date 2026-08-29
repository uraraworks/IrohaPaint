// 表記(漢字＋総ルビ)の描画。
//
// 企画書§4.2: L2 は「漢字＋ふりがな」。<ruby> はブラウザ標準機能なので
// ライブラリを持ち込まずに済む。L3(ふりがなオフ)は CSS で rt を隠すだけにしたいので、
// DOM には常にルビを入れておき、見せるかどうかだけを切り替えられる形にする。
import { plainLabel, type LabelPart, type ToolDef } from "../core/tools.ts";

export type NotationLevel = "L1" | "L2" | "L3";

/** ツール名を <ruby> 付きの断片として組み立てる。 */
export function renderLabel(def: ToolDef): DocumentFragment {
  return renderRuby(def.label);
}

/** 任意の文言を <ruby> 付きで組み立てる(道具名以外の UI 文言もすべてこれを通す)。 */
export function renderRuby(parts: readonly LabelPart[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    if (part.ruby === undefined) {
      fragment.appendChild(document.createTextNode(part.base));
      continue;
    }
    const ruby = document.createElement("ruby");
    ruby.appendChild(document.createTextNode(part.base));
    const rt = document.createElement("rt");
    rt.textContent = part.ruby;
    ruby.appendChild(rt);
    fragment.appendChild(ruby);
  }
  return fragment;
}

/** ふりがなを外した文字列。読み上げ(aria-label)に使う。 */
export function plainText(parts: readonly LabelPart[]): string {
  return parts.map((part) => part.base).join("");
}

/** 読み上げ・ツールチップ用の素の文字列。 */
export function labelText(def: ToolDef): string {
  return plainLabel(def);
}

/** 表記レベルの切替(Phase 1 で UI から呼ぶ想定)。今は L3 で rt を隠すだけ。 */
export function applyNotationLevel(root: HTMLElement, level: NotationLevel): void {
  root.dataset.notation = level;
}
