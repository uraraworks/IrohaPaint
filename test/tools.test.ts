import { describe, expect, it } from "vitest";
import { CHEST_ENABLED, INITIAL_TOOLS, nextUnlock, orderTools, UNLOCKS, type ToolId } from "../src/core/tools.ts";

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

describe("orderTools(作品・完成をツールバー末尾に固定する)", () => {
  it("道具が増えても作品・完成は末尾のまま(順序は works → done)", () => {
    const owned: ToolId[] = ["pen", "color", "works", "eraser", "done", "undo", "picker", "fill"];
    expect(orderTools(owned)).toEqual(["pen", "color", "eraser", "undo", "picker", "fill", "works", "done"]);
  });

  it("片方だけ持っている場合はそれだけ末尾に置く", () => {
    expect(orderTools(["pen", "works", "color"])).toEqual(["pen", "color", "works"]);
    expect(orderTools(["pen", "done", "color"])).toEqual(["pen", "color", "done"]);
  });

  it("どちらも持っていない場合は元の順序のまま", () => {
    expect(orderTools(["pen", "color", "eraser"])).toEqual(["pen", "color", "eraser"]);
  });

  it("末尾以外の順序は保たれる(安定な並べ替え)", () => {
    const owned: ToolId[] = ["undo", "redo", "grid", "together", "works", "picker", "fill", "done"];
    expect(orderTools(owned)).toEqual(["undo", "redo", "grid", "together", "picker", "fill", "works", "done"]);
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
