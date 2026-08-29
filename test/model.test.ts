import { describe, expect, it } from "vitest";
import { appendSnapshot, createWork, MAX_SNAPSHOTS, snapshotOf } from "../src/core/model.ts";
import { MemoryWorkStore } from "../src/core/workStore.ts";

const dummy = { size: 1 } as unknown as Blob;

describe("作品データモデル", () => {
  it("新規作品は 1 ページ・未削除・マーク無しで始まる", () => {
    const work = createWork(dummy, 1000);
    expect(work.pages.length).toBe(1);
    expect(work.deleted).toBe(false);
    expect(work.markId).toBeNull();
    expect(work.snapshots).toEqual([]);
  });

  it("スナップショットは追記され、上限を超えると古い側が落ちる", () => {
    let work = createWork(dummy, 0);
    for (let i = 0; i < MAX_SNAPSHOTS + 5; i += 1) {
      work = appendSnapshot(work, snapshotOf(work, i + 1));
    }
    expect(work.snapshots.length).toBe(MAX_SNAPSHOTS);
    // 直近は必ず残る
    expect(work.snapshots.at(-1)?.createdAt).toBe(MAX_SNAPSHOTS + 5);
  });
});

describe("MemoryWorkStore", () => {
  it("削除フラグの立った作品は一覧に出ない(レコード自体は消えない)", async () => {
    const store = new MemoryWorkStore();
    const alive = createWork(dummy, 10);
    const trashed = { ...createWork(dummy, 20), deleted: true };
    await store.put(alive);
    await store.put(trashed);
    expect((await store.list()).map((w) => w.id)).toEqual([alive.id]);
    expect(await store.get(trashed.id)).not.toBeNull();
  });

  it("一覧は更新の新しい順", async () => {
    const store = new MemoryWorkStore();
    const older = createWork(dummy, 10);
    const newer = createWork(dummy, 99);
    await store.put(older);
    await store.put(newer);
    expect((await store.list()).map((w) => w.id)).toEqual([newer.id, older.id]);
  });
});
