import { describe, expect, it } from "vitest";
import { CHEST_ENABLED, INITIAL_TOOLS, nextUnlock, UNLOCKS, type ToolId } from "../src/core/tools.ts";

/** 宝箱を使うときの初期道具（解放ぶんを含まない状態）。 */
const STARTER: readonly ToolId[] = INITIAL_TOOLS.filter(
  (id) => !UNLOCKS.some((unlock) => unlock.tool === id),
);

describe("道具の初期状態", () => {
  it("いまは宝箱 OFF なので、最初から全部の道具がある", () => {
    expect(CHEST_ENABLED).toBe(false);
    for (const unlock of UNLOCKS) {
      expect(INITIAL_TOOLS).toContain(unlock.tool);
    }
  });

  it("宝箱 OFF のあいだは解放が起きない", () => {
    expect(nextUnlock(9999, STARTER)).toBeNull();
  });
});

// 宝箱を ON に戻したときの振る舞い。仕組みは残してあるので直接検証する。
describe("nextUnlock（宝箱 ON のときの規則）", () => {
  const owned = STARTER;

  it("描き始めは何も解放しない(起動直後に説明を出さない)", () => {
    expect(chestRule(0, owned)).toBeNull();
    expect(chestRule(5, owned)).toBeNull();
  });

  it("しきい値に達したら 1 個だけ返す", () => {
    const first = UNLOCKS[0]!;
    expect(chestRule(first.strokes, owned)?.tool).toBe(first.tool);
  });

  it("しきい値をまとめて超えても順番どおり 1 個ずつ", () => {
    const [first, second] = [UNLOCKS[0]!, UNLOCKS[1]!];
    expect(chestRule(second.strokes + 100, owned)?.tool).toBe(first.tool);
    expect(chestRule(second.strokes + 100, [...owned, first.tool])?.tool).toBe(second.tool);
  });

  it("全部持っていたら null", () => {
    expect(chestRule(9999, [...owned, ...UNLOCKS.map((u) => u.tool)])).toBeNull();
  });
});

/** nextUnlock から「宝箱 ON/OFF の判定」だけを外したもの。 */
function chestRule(strokeCount: number, ownedTools: readonly ToolId[]) {
  for (const unlock of UNLOCKS) {
    if (ownedTools.includes(unlock.tool)) continue;
    if (strokeCount >= unlock.strokes) return unlock;
    return null;
  }
  return null;
}
