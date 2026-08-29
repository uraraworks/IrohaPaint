import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProgress, saveProgress } from "../src/core/progress.ts";
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
      grid: true,
      nib: "gpen",
    });
    const progress = loadProgress();
    expect(progress.ownedTools).toContain("picker");
    expect(progress.strokeCount).toBe(17);
    expect(progress.currentWorkId).toBe("work-1");
    expect(progress.grid).toBe(true);
    expect(progress.nib).toBe("gpen");
  });

  it("保存データが壊れていても初期道具は必ず揃う", () => {
    installStorage({ "iroha-paint:progress": '{"ownedTools":["nope",42],"strokeCount":-5}' });
    const progress = loadProgress();
    expect(progress.ownedTools).toEqual([...INITIAL_TOOLS]);
    expect(progress.strokeCount).toBe(0);
    expect(progress.nib).toBe("crayon");
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
      saveProgress({ ownedTools: [], strokeCount: 0, currentWorkId: null, grid: false, nib: "crayon" }),
    ).not.toThrow();
  });
});
