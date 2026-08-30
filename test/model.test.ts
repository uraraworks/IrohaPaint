import { describe, expect, it } from "vitest";
import {
  appendSnapshot,
  CANVAS_HEIGHT,
  CANVAS_SIZE_ORDER,
  CANVAS_SIZES,
  CANVAS_WIDTH,
  createWork,
  KEEP_RECENT,
  MAX_SNAPSHOTS,
  snapshotOf,
  thinSnapshots,
  type WorkSnapshot,
} from "../src/core/model.ts";
import { MemoryWorkStore, unwrap, type StoredEnvelope } from "../src/core/workStore.ts";
import { SCHEMA_VERSION, type WorkRecord } from "../src/core/model.ts";

const dummy = { size: 1 } as unknown as Blob;

describe("作品データモデル", () => {
  it("新規作品は 1 ページ・未削除・マーク無しで始まる", () => {
    const work = createWork(dummy, 1000);
    expect(work.pages.length).toBe(1);
    expect(work.deleted).toBe(false);
    expect(work.markId).toBeNull();
    expect(work.snapshots).toEqual([]);
  });

  it("新規作品は現在のキャンバス寸法を記録する", () => {
    const work = createWork(dummy, 1000);
    expect(work.canvasWidth).toBe(CANVAS_WIDTH);
    expect(work.canvasHeight).toBe(CANVAS_HEIGHT);
  });

  it("寸法を明示的に渡せば、それが記録される(将来のサイズ選択用)", () => {
    const work = createWork(dummy, 1000, undefined, 1181, 1748);
    expect(work.canvasWidth).toBe(1181);
    expect(work.canvasHeight).toBe(1748);
  });

  it("新規ページは deleted:false で始まる", () => {
    const work = createWork(dummy, 1000);
    expect(work.pages[0]?.deleted).toBe(false);
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

describe("workStore の unwrap(古い保存データの読み込み)", () => {
  it("寸法・deleted の無い古い形のデータでも捨てず、既定値を補って読み込む", () => {
    // 公開前に保存された形を模す(canvasWidth/canvasHeight・pages[].deleted 無し)。
    const legacyWork = {
      id: "work-legacy",
      createdAt: 1,
      updatedAt: 1,
      markId: null,
      deleted: false,
      pages: [{ id: "page-legacy", image: dummy }],
      snapshots: [],
    } as unknown as WorkRecord;
    const envelope: StoredEnvelope = { version: SCHEMA_VERSION, work: legacyWork };

    const restored = unwrap(envelope);

    expect(restored).not.toBeNull();
    expect(restored?.canvasWidth).toBe(CANVAS_WIDTH);
    expect(restored?.canvasHeight).toBe(CANVAS_HEIGHT);
    expect(restored?.pages[0]?.deleted).toBe(false);
    // 元の中身(画像など)はそのまま保たれる
    expect(restored?.pages[0]?.id).toBe("page-legacy");
  });

  it("新しい形のデータはそのまま(既定値で上書きしない)", () => {
    const work = createWork(dummy, 1000, undefined, 1181, 1748);
    const withDeletedPage: WorkRecord = {
      ...work,
      pages: [{ ...work.pages[0]!, deleted: true }],
    };
    const envelope: StoredEnvelope = { version: SCHEMA_VERSION, work: withDeletedPage };

    const restored = unwrap(envelope);

    expect(restored?.canvasWidth).toBe(1181);
    expect(restored?.canvasHeight).toBe(1748);
    expect(restored?.pages[0]?.deleted).toBe(true);
  });

  it("バージョン不一致は読み込まない(壊れたデータで起動しない)", () => {
    const work = createWork(dummy, 1000);
    const envelope = { version: SCHEMA_VERSION + 1, work } as StoredEnvelope;
    expect(unwrap(envelope)).toBeNull();
  });
});

describe("CANVAS_SIZES(将来のサイズ選択用の表・まだ未使用)", () => {
  it("表の全項目が CANVAS_SIZE_ORDER に過不足なく並ぶ", () => {
    expect(CANVAS_SIZE_ORDER.length).toBe(Object.keys(CANVAS_SIZES).length);
    for (const id of CANVAS_SIZE_ORDER) expect(CANVAS_SIZES[id].id).toBe(id);
  });

  it("postcard-landscape は現行の横長サイズと一致する", () => {
    const def = CANVAS_SIZES["postcard-landscape"];
    expect(def.width).toBe(CANVAS_WIDTH);
    expect(def.height).toBe(CANVAS_HEIGHT);
    expect(def.width).toBeGreaterThan(def.height);
  });

  it("postcard-portrait は横長を 90 度回した縦長サイズ", () => {
    const def = CANVAS_SIZES["postcard-portrait"];
    expect(def.width).toBe(CANVAS_HEIGHT);
    expect(def.height).toBe(CANVAS_WIDTH);
    expect(def.height).toBeGreaterThan(def.width);
  });

  it("manga-b4 は縦長で、短辺がポストカード枠と揃っている", () => {
    const def = CANVAS_SIZES["manga-b4"];
    expect(def.height).toBeGreaterThan(def.width);
    expect(def.width).toBe(CANVAS_WIDTH);
    // 実寸 257x364mm の縦横比を保っているか(四捨五入の誤差 1px 未満)
    expect(def.height).toBeCloseTo((def.width * 364) / 257, 0);
  });
});
