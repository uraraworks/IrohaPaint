import { describe, expect, it } from "vitest";
import { GRID_MODE_ORDER, GRID_MODES, isGridMode } from "../src/core/grid.ts";

describe("下敷きの種類", () => {
  it("写真は下敷きの種類として認識される", () => {
    expect(isGridMode("photo")).toBe(true);
  });

  it("写真は選択肢の並びに含まれ、マスに吸着しない", () => {
    expect(GRID_MODE_ORDER).toContain("photo");
    expect(GRID_MODES.photo.snap).toBe(false);
  });
});
