import { describe, expect, it } from "vitest";
import { INITIAL_TOOLS, nextUnlock, UNLOCKS } from "../src/core/tools.ts";

describe("nextUnlock", () => {
  it("描き始めは何も解放しない(起動直後に説明を出さない)", () => {
    expect(nextUnlock(0, INITIAL_TOOLS)).toBeNull();
    expect(nextUnlock(5, INITIAL_TOOLS)).toBeNull();
  });

  it("しきい値に達したら 1 個だけ返す", () => {
    const first = UNLOCKS[0]!;
    expect(nextUnlock(first.strokes, INITIAL_TOOLS)?.tool).toBe(first.tool);
  });

  it("しきい値をまとめて超えても順番どおり 1 個ずつ", () => {
    const [first, second] = [UNLOCKS[0]!, UNLOCKS[1]!];
    expect(nextUnlock(second.strokes + 100, INITIAL_TOOLS)?.tool).toBe(first.tool);
    expect(nextUnlock(second.strokes + 100, [...INITIAL_TOOLS, first.tool])?.tool).toBe(second.tool);
  });

  it("全部持っていたら null", () => {
    const all = [...INITIAL_TOOLS, ...UNLOCKS.map((u) => u.tool)];
    expect(nextUnlock(9999, all)).toBeNull();
  });
});
