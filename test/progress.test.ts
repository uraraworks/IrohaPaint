import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProgress, nextScreenFilter, saveProgress } from "../src/core/progress.ts";
import { INITIAL_TOOLS } from "../src/core/tools.ts";

/** localStorage が無い Node 環境用の最小実装。 */
function installStorage(initial: Record<string, string> = {}): void {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  });
}

describe("進捗の保存", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("保存した道具と描いた量が戻る", () => {
    installStorage();
    saveProgress({
      ownedTools: [...INITIAL_TOOLS, "picker"],
      strokeCount: 17,
      currentWorkId: "work-1",
      gridMode: "beads",
      underlayId: "under-1",
      nib: "gpen",
      multiDraw: true,
      screenFilter: "night",
    });
    const progress = loadProgress();
    expect(progress.ownedTools).toContain("picker");
    expect(progress.strokeCount).toBe(17);
    expect(progress.currentWorkId).toBe("work-1");
    expect(progress.gridMode).toBe("beads");
    expect(progress.underlayId).toBe("under-1");
    expect(progress.nib).toBe("gpen");
    expect(progress.multiDraw).toBe(true);
    expect(progress.screenFilter).toBe("night");
  });

  it("下敷きが無ければ underlayId は null のまま", () => {
    installStorage();
    saveProgress({
      ownedTools: [...INITIAL_TOOLS],
      strokeCount: 0,
      currentWorkId: null,
      gridMode: "off",
      underlayId: null,
      nib: "crayon",
      multiDraw: false,
      screenFilter: "normal",
    });
    expect(loadProgress().underlayId).toBeNull();
  });

  it("保存データが壊れていても初期道具は必ず揃う", () => {
    installStorage({ "iroha-paint:progress": '{"ownedTools":["nope",42],"strokeCount":-5}' });
    const progress = loadProgress();
    expect(progress.ownedTools).toEqual([...INITIAL_TOOLS]);
    expect(progress.strokeCount).toBe(0);
    expect(progress.nib).toBe("crayon");
    expect(progress.screenFilter).toBe("normal");
  });

  it("壊れた画面フィルタ値は ふつう にフォールバックする", () => {
    installStorage({ "iroha-paint:progress": '{"screenFilter":"space"}' });
    expect(loadProgress().screenFilter).toBe("normal");
  });

  it("localStorage が使えなくても落ちない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(loadProgress().ownedTools).toEqual([...INITIAL_TOOLS]);
    expect(() =>
      saveProgress({
        ownedTools: [],
        strokeCount: 0,
        currentWorkId: null,
        gridMode: "off",
        underlayId: null,
        nib: "crayon",
        multiDraw: false,
        screenFilter: "normal",
      }),
    ).not.toThrow();
  });
});

describe("nextScreenFilter(画面フィルタの4段階を一周する)", () => {
  it("ふつう → やわらか → くらい → よる → ふつう の順に一周する", () => {
    expect(nextScreenFilter("normal")).toBe("soft");
    expect(nextScreenFilter("soft")).toBe("dark");
    expect(nextScreenFilter("dark")).toBe("night");
    expect(nextScreenFilter("night")).toBe("normal");
  });
});
