import { describe, expect, it } from "vitest";
import {
  appendSnapshot,
  createWork,
  KEEP_RECENT,
  MAX_SNAPSHOTS,
  snapshotOf,
  thinSnapshots,
  type WorkSnapshot,
} from "../src/core/model.ts";
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

  it("スナップショットは追記され、上限を超えない", () => {
    let work = createWork(dummy, 0);
    const base = Date.now();
    for (let i = 0; i < MAX_SNAPSHOTS + 20; i += 1) {
      work = appendSnapshot(work, snapshotOf(work, base + i * 1000, "auto"));
    }
    expect(work.snapshots.length).toBeLessThanOrEqual(MAX_SNAPSHOTS);
    // 直近は必ず残る
    expect(work.snapshots.at(-1)?.createdAt).toBe(base + (MAX_SNAPSHOTS + 19) * 1000);
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

describe("ゴミばこ(ソフトデリート)", () => {
  it("すてても get では取れ、とりもどすと一覧へ戻る", async () => {
    const store = new MemoryWorkStore();
    const work = createWork(dummy, 10);
    await store.put(work);

    expect(await store.setDeleted(work.id, true)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect((await store.listDeleted()).map((w) => w.id)).toEqual([work.id]);
    expect(await store.get(work.id)).not.toBeNull();

    await store.setDeleted(work.id, false);
    expect((await store.list()).map((w) => w.id)).toEqual([work.id]);
    expect(await store.listDeleted()).toEqual([]);
  });

  it("知らない ID なら false を返すだけ(落とさない)", async () => {
    expect(await new MemoryWorkStore().setDeleted("nope", true)).toBe(false);
  });
});

describe("thinSnapshots", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 7, 29, 12, 0, 0).getTime();

  function snap(createdAt: number, id: string): WorkSnapshot {
    return { id, createdAt, pages: [], reason: "auto" };
  }

  it("直近のぶんはそのまま残る", () => {
    const list = Array.from({ length: KEEP_RECENT }, (_, i) => snap(now - i * 60_000, `s${i}`));
    expect(thinSnapshots(list, now).length).toBe(KEEP_RECENT);
  });

  it("古い日は 1 日 1 枚(その日の最後)に間引かれる", () => {
    // 5 日前に 4 枚。直近枠に入らないよう、新しい側も十分に積む。
    const old = [0, 1, 2, 3].map((i) => snap(now - 5 * DAY + i * 3600_000, `old${i}`));
    const recent = Array.from({ length: KEEP_RECENT }, (_, i) => snap(now - i * 60_000, `new${i}`));
    const kept = thinSnapshots([...old, ...recent], now);
    const keptOld = kept.filter((s) => s.id.startsWith("old"));
    expect(keptOld.map((s) => s.id)).toEqual(["old3"]);
  });

  it("上限を超えない", () => {
    const many = Array.from({ length: 300 }, (_, i) => snap(now - i * 3600_000, `s${i}`));
    expect(thinSnapshots(many, now).length).toBeLessThanOrEqual(MAX_SNAPSHOTS);
  });

  it("古い順に並べて返す", () => {
    const list = [snap(now, "b"), snap(now - 10_000, "a")];
    expect(thinSnapshots(list, now).map((s) => s.id)).toEqual(["a", "b"]);
  });
});
