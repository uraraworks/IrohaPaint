// 道具箱の中身と描いた量。
//
// 作品(WorkRecord)ではなく *使う人* に属するので保存先を分ける。
// 一度増えた道具は絶対に減らない ... 宝箱で増える体験の前提が崩れるため、
// リロードやタブを閉じた後も必ず残す。
// 量が小さく同期的に読めればよいので localStorage で足りる(IndexedDB は要らない)。
import { INITIAL_TOOLS, TOOL_DEFS, type ToolId } from "./tools.ts";

const KEY = "sodatsu-paint:progress";

export interface Progress {
  ownedTools: ToolId[];
  strokeCount: number;
}

export function loadProgress(): Progress {
  const fallback: Progress = { ownedTools: [...INITIAL_TOOLS], strokeCount: 0 };
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
