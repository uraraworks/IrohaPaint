// 道具箱の中身と描いた量。
//
// 作品(WorkRecord)ではなく *使う人* に属するので保存先を分ける。
// 一度増えた道具は絶対に減らない ... 宝箱で増える体験の前提が崩れるため、
// リロードやタブを閉じた後も必ず残す。
// 量が小さく同期的に読めればよいので localStorage で足りる(IndexedDB は要らない)。
import { INITIAL_TOOLS, TOOL_DEFS, type ToolId } from "./tools.ts";
import { isNibId, type NibId } from "./brush.ts";
import { isGridMode, type GridMode } from "./grid.ts";

const KEY = "iroha-paint:progress";

/**
 * 画面フィルタ(目の負担を減らす表示)。表示だけの層で絵には一切影響しない。
 * ふつう → やわらか → くらい → よる → ふつう … の順に一周する。
 */
export type ScreenFilterMode = "normal" | "soft" | "dark" | "night";

/** 押すたびに巡る順番。 */
export const SCREEN_FILTER_ORDER: readonly ScreenFilterMode[] = ["normal", "soft", "dark", "night"];

function isScreenFilterMode(value: unknown): value is ScreenFilterMode {
  return typeof value === "string" && (SCREEN_FILTER_ORDER as readonly string[]).includes(value);
}

/** 次の段階を返す(4段階を一周する)。 */
export function nextScreenFilter(mode: ScreenFilterMode): ScreenFilterMode {
  const index = SCREEN_FILTER_ORDER.indexOf(mode);
  return SCREEN_FILTER_ORDER[(index + 1) % SCREEN_FILTER_ORDER.length]!;
}

export interface Progress {
  ownedTools: ToolId[];
  strokeCount: number;
  /** いま開いている作品。次に起動したときも同じ絵の続きから描けるようにする。 */
  currentWorkId: string | null;
  /** 下敷き(なし / 方眼 / ビーズ / 写真)。作品ではなく人に属する設定。 */
  gridMode: GridMode;
  /** 下敷きに選んでいる写真の id(underlayStore のキー)。gridMode が "photo" のときだけ意味を持つ。 */
  underlayId: string | null;
  /** 選んでいるペン先。 */
  nib: NibId;
  /** 「みんなで描く」モード。 */
  multiDraw: boolean;
  /**
   * 画面フィルタの段階。
   *
   * 下敷きの「かくす」はあえて保存しない(隠したまま次に開くと「写真モードなのに
   * 何も出ない」という原因不明の状態になるため)。一方フィルタは暗くなっているだけで
   * 見れば何が起きているか一目で分かるので、原因不明にはならない。むしろ前回の
   * 設定を覚えている方が親切なので、こちらは保存する。
   */
  screenFilter: ScreenFilterMode;
}

export function loadProgress(): Progress {
  const fallback: Progress = {
    ownedTools: [...INITIAL_TOOLS],
    strokeCount: 0,
    currentWorkId: null,
    gridMode: "off",
    underlayId: null,
    nib: "crayon",
    multiDraw: false,
    screenFilter: "normal",
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<Progress>;
    const tools = Array.isArray(parsed.ownedTools)
      ? parsed.ownedTools.filter((id): id is ToolId => typeof id === "string" && id in TOOL_DEFS)
      : [];
    // 初期道具は何があっても必ず入っている(壊れた保存データで道具が消えないように)。
    const owned = [...INITIAL_TOOLS, ...tools.filter((id) => !INITIAL_TOOLS.includes(id))];
    return {
      ownedTools: owned,
      strokeCount: typeof parsed.strokeCount === "number" && parsed.strokeCount >= 0 ? parsed.strokeCount : 0,
      currentWorkId: typeof parsed.currentWorkId === "string" ? parsed.currentWorkId : null,
      gridMode: isGridMode(parsed.gridMode) ? parsed.gridMode : "off",
      underlayId: typeof parsed.underlayId === "string" ? parsed.underlayId : null,
      nib: isNibId(parsed.nib) ? parsed.nib : "crayon",
      multiDraw: parsed.multiDraw === true,
      screenFilter: isScreenFilterMode(parsed.screenFilter) ? parsed.screenFilter : "normal",
    };
  } catch {
    // プライベートブラウズ等で localStorage が使えなくても描けることを優先する。
    return fallback;
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // 保存できなくても描画は続けられるべきなので握りつぶす。
  }
}
