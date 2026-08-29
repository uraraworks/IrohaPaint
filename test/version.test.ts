import { describe, expect, it } from "vitest";
// @ts-expect-error -- ビルド設定側と共有する .mjs(型定義は持たない)
import { formatVersion, UNKNOWN_VERSION } from "../tools/version.mjs";

describe("formatVersion", () => {
  // 2026-08-30 00:39 JST = 2026-08-29 15:39 UTC
  const ts = Date.UTC(2026, 7, 29, 15, 39, 0) / 1000;

  it("commit 時刻を JST で整形し、短縮ハッシュを添える", () => {
    expect(formatVersion(ts, "5e22b7f", false).label).toBe("2026-08-30 00:39 JST (5e22b7f)");
  });

  it("作業ツリーが汚れていれば印を付ける", () => {
    const { label, buildId } = formatVersion(ts, "5e22b7f", true);
    expect(label).toContain("5e22b7f+");
    // URL に載る値では "+" を避ける("+" は空白に解釈されうる)
    expect(buildId).toBe("5e22b7f-dirty");
  });

  it("ホストのタイムゾーンに結果を左右されない", () => {
    // 固定オフセット計算なので、同じ入力なら必ず同じ出力になる
    expect(formatVersion(0, "0000000", false).label).toBe("1970-01-01 09:00 JST (0000000)");
  });

  it("git が使えないときは「不明」と分かる値にする", () => {
    expect(UNKNOWN_VERSION.label).toBe("version unknown");
  });
});
