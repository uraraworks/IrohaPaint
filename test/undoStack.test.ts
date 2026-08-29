import { describe, expect, it } from "vitest";
import { DirtyRect, trimPatches, type UndoPatch } from "../src/core/undoStack.ts";

function patch(width: number, height: number): UndoPatch {
  return { x: 0, y: 0, width, height, before: { width, height } as unknown as ImageData };
}

describe("trimPatches", () => {
  it("バイト上限を超えたら古い方から捨てる", () => {
    const patches = [patch(100, 100), patch(100, 100), patch(100, 100)];
    const budget = 100 * 100 * 4 * 2;
    expect(trimPatches(patches, budget).length).toBe(2);
  });

  it("1 件だけなら上限を超えても残す(直前の 1 回は必ず戻せる)", () => {
    expect(trimPatches([patch(1000, 1000)], 1).length).toBe(1);
  });

  it("件数上限も効く", () => {
    const patches = Array.from({ length: 60 }, () => patch(4, 4));
    expect(trimPatches(patches, Number.MAX_SAFE_INTEGER, 10).length).toBe(10);
  });
});

describe("DirtyRect", () => {
  it("線の太さ分だけ矩形を広げる", () => {
    const rect = new DirtyRect();
    rect.add(50, 50, 10);
    expect(rect.toRect(200, 200)).toEqual({ x: 40, y: 40, width: 21, height: 21 });
  });

  it("キャンバスからはみ出さない", () => {
    const rect = new DirtyRect();
    rect.add(0, 0, 30);
    expect(rect.toRect(100, 100)).toEqual({ x: 0, y: 0, width: 31, height: 31 });
  });

  it("何も足していなければ null", () => {
    expect(new DirtyRect().toRect(100, 100)).toBeNull();
  });
});
