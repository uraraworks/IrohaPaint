import { describe, expect, it } from "vitest";
import { createId, createWork, type PageData, type WorkRecord, type WorkSnapshot } from "../src/core/model.ts";
import { FRAME_PRESETS, type FrameData } from "../src/core/frame.ts";
import {
  assignLegacyVersionIds,
  joinWork,
  splitWork,
  unreferencedVersionIds,
  VERSION_GC_GRACE_MS,
  type PageVersion,
} from "../src/core/pageVersions.ts";

function blob(): Blob {
  return new Blob([Math.random().toString()]);
}

function page(image: Blob, versionId = createId("ver")): PageData {
  const id = createId("page");
  return {
    id,
    image,
    deleted: false,
    layers: [{ id: `${id}-layer-0`, image, visible: true, opacity: 1, deleted: false }],
    versionId,
  };
}

function versionsMap(versions: readonly PageVersion[]): Map<string, PageVersion> {
  return new Map(versions.map((v) => [v.versionId, v]));
}

describe("splitWork / joinWork の往復", () => {
  it("分解して組み立てると元の作品に戻る", () => {
    const work = createWork(blob(), 1000);
    const snapPage = page(blob());
    const snapshot: WorkSnapshot = { id: createId("snap"), createdAt: 2000, pages: [snapPage], reason: "auto" };
    const withHistory: WorkRecord = { ...work, snapshots: [snapshot] };

    const { stored, versions } = splitWork(withHistory, 3000);
    const restored = joinWork(stored, versionsMap(versions));

    expect(restored).toEqual(withHistory);
  });

  it("animation と activePageId を往復で保つ(活動中のコマ ID 込み)", () => {
    const work = createWork(blob(), 1000);
    const activePage = page(blob());
    const withAnimation: WorkRecord = {
      ...work,
      pages: [activePage],
      animation: true,
      activePageId: activePage.id,
    };

    const { stored, versions } = splitWork(withAnimation, 3000);
    const restored = joinWork(stored, versionsMap(versions));

    expect(restored).toEqual(withAnimation);
  });

  it("activePageId が無い作品は往復しても無いまま(false のときは省かれる)", () => {
    const work = createWork(blob(), 1000);

    const { stored, versions } = splitWork(work, 3000);

    expect(stored.activePageId).toBeUndefined();
    expect(stored.animation).toBe(false);

    const restored = joinWork(stored, versionsMap(versions));

    expect(restored?.activePageId).toBeUndefined();
    expect(restored?.animation).toBe(false);
  });

  it("今のページと控えが同じ版を指していれば、版の一覧では重複排除される", () => {
    const shared = page(blob());
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [shared] };
    const snapshot: WorkSnapshot = { id: createId("snap"), createdAt: 500, pages: [shared], reason: "open" };
    const withHistory: WorkRecord = { ...work, snapshots: [snapshot] };

    const { versions } = splitWork(withHistory, 3000);

    expect(versions.length).toBe(1);
    expect(versions[0]?.versionId).toBe(shared.versionId);
  });
});

describe("splitWork / joinWork と frame(わく)", () => {
  it("frame 付きのページは往復しても frame が残る", () => {
    const frame = FRAME_PRESETS.yonkoma.frame!;
    const work = createWork(blob(), 1000);
    const framedPage: PageData = { ...work.pages[0]!, frame };
    const withFrame: WorkRecord = { ...work, pages: [framedPage] };

    const { stored, versions } = splitWork(withFrame, 3000);
    const restored = joinWork(stored, versionsMap(versions));

    expect(restored?.pages[0]?.frame).toEqual(frame);
    expect(restored).toEqual(withFrame);
  });

  it("frame 無しのページは往復しても frame 自体が無いまま", () => {
    const work = createWork(blob(), 1000);

    const { stored, versions } = splitWork(work, 3000);
    const restored = joinWork(stored, versionsMap(versions));

    expect(restored?.pages[0]?.frame).toBeUndefined();
    expect("frame" in (restored?.pages[0] ?? {})).toBe(false);
  });

  it("不正な frame は joinWork で落ちる(版に混ざっていても読めない)", () => {
    const brokenFrame = { margin: -1 } as unknown as FrameData;
    const work = createWork(blob(), 1000);
    const framedPage: PageData = { ...work.pages[0]!, frame: brokenFrame };
    const withFrame: WorkRecord = { ...work, pages: [framedPage] };

    const { stored, versions } = splitWork(withFrame, 3000);
    const restored = joinWork(stored, versionsMap(versions));

    expect(restored?.pages[0]?.frame).toBeUndefined();
  });
});

describe("joinWork: 版が欠けていたとき", () => {
  it("控えの版が欠けていたら、その控えだけ落ちる(他の控えは活きる)", () => {
    const okPage = page(blob());
    const missingPage = page(blob());
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [okPage] };
    const okSnapshot: WorkSnapshot = { id: createId("snap"), createdAt: 100, pages: [okPage], reason: "auto" };
    const brokenSnapshot: WorkSnapshot = { id: createId("snap"), createdAt: 200, pages: [missingPage], reason: "auto" };
    const withHistory: WorkRecord = { ...work, snapshots: [okSnapshot, brokenSnapshot] };

    const { stored, versions } = splitWork(withHistory, 3000);
    // missingPage の版だけ意図的に取り除く
    const trimmed = versions.filter((v) => v.versionId !== missingPage.versionId);

    const restored = joinWork(stored, versionsMap(trimmed));

    expect(restored?.snapshots.map((s) => s.id)).toEqual([okSnapshot.id]);
    expect(restored?.pages).toEqual([okPage]);
  });

  it("今のページの版が欠けていたら、版が揃っているいちばん新しい控えで補う", () => {
    const currentPage = page(blob());
    const olderPage = page(blob());
    const newerPage = page(blob());
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [currentPage] };
    const olderSnapshot: WorkSnapshot = { id: createId("snap"), createdAt: 100, pages: [olderPage], reason: "auto" };
    const newerSnapshot: WorkSnapshot = { id: createId("snap"), createdAt: 200, pages: [newerPage], reason: "auto" };
    const withHistory: WorkRecord = { ...work, snapshots: [olderSnapshot, newerSnapshot] };

    const { stored, versions } = splitWork(withHistory, 3000);
    // 今のページの版だけ欠けさせる
    const trimmed = versions.filter((v) => v.versionId !== currentPage.versionId);

    const restored = joinWork(stored, versionsMap(trimmed));

    expect(restored?.pages).toEqual([newerPage]);
  });

  it("今のページも控えも版が揃わなければ null(壊れたデータと同じ扱い)", () => {
    const currentPage = page(blob());
    const snapPage = page(blob());
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [currentPage] };
    const snapshot: WorkSnapshot = { id: createId("snap"), createdAt: 100, pages: [snapPage], reason: "auto" };
    const withHistory: WorkRecord = { ...work, snapshots: [snapshot] };

    const { stored } = splitWork(withHistory, 3000);

    expect(joinWork(stored, new Map())).toBeNull();
  });
});

describe("assignLegacyVersionIds(古い形の読み込み)", () => {
  it("同じ Blob を共有していたページは同じ版に畳まれ、別の Blob は別の版になる", () => {
    const image = blob();
    const pageA = page(image, "old-id-a");
    const pageB = page(image, "old-id-b");
    const otherImage = blob();
    const pageC = page(otherImage, "old-id-c");
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [pageA] };
    const snapshot: WorkSnapshot = { id: createId("snap"), createdAt: 100, pages: [pageB, pageC], reason: "auto" };
    const withHistory: WorkRecord = { ...work, snapshots: [snapshot] };

    const restored = assignLegacyVersionIds(withHistory);

    const restoredA = restored.pages[0]!;
    const restoredB = restored.snapshots[0]!.pages[0]!;
    const restoredC = restored.snapshots[0]!.pages[1]!;
    expect(restoredA.versionId).toBe(restoredB.versionId);
    expect(restoredA.versionId).not.toBe(restoredC.versionId);
    // 既に入っていた ID(old-id-*)は無視して必ず振り直す
    expect(restoredA.versionId).not.toBe("old-id-a");
  });

  it("2 回呼ぶと(毎回ランダムなので)版 ID が変わる", () => {
    const work: WorkRecord = { ...createWork(blob(), 1000) };

    const first = assignLegacyVersionIds(work);
    const second = assignLegacyVersionIds(work);

    expect(first.pages[0]?.versionId).not.toBe(second.pages[0]?.versionId);
  });
});

describe("unreferencedVersionIds(掃除の判断)", () => {
  it("参照中の版と、作られて 10 分未満の版は対象外にする", () => {
    const referencedPage = page(blob());
    const work: WorkRecord = { ...createWork(blob(), 1000), pages: [referencedPage] };
    const { stored } = splitWork(work, 3000);

    const now = 100_000;
    const existing = [
      { versionId: referencedPage.versionId, createdAt: now - VERSION_GC_GRACE_MS - 1 }, // 参照中
      { versionId: "unref-old", createdAt: now - VERSION_GC_GRACE_MS - 1 }, // 未参照・猶予後 → 対象
      { versionId: "unref-fresh", createdAt: now - 1000 }, // 未参照だが猶予中 → 対象外
    ];

    expect(unreferencedVersionIds(stored, existing, now)).toEqual(["unref-old"]);
  });
});
