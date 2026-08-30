import { describe, expect, it } from "vitest";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../src/core/model.ts";
import {
  clampPlacement,
  createUnderlay,
  DEFAULT_UNDERLAY_OPACITY,
  fitPlacement,
  fitSize,
  MAX_UNDERLAYS,
  pickEvicted,
  scaleAt,
  UNDERLAY_MAX_EDGE,
  UNDERLAY_MAX_SCALE_RATIO,
  UNDERLAY_MIN_SCALE_RATIO,
} from "../src/core/underlay.ts";
import { MemoryUnderlayStore, pruneUnderlays } from "../src/core/underlayStore.ts";

const dummy = { size: 1 } as unknown as Blob;
const dummyThumb = { size: 1 } as unknown as Blob;

describe("fitSize", () => {
  it("長辺が上限以下ならそのまま", () => {
    expect(fitSize(1000, 500)).toEqual({ width: 1000, height: 500 });
    expect(fitSize(UNDERLAY_MAX_EDGE, 100)).toEqual({ width: UNDERLAY_MAX_EDGE, height: 100 });
  });

  it("長辺が上限を超えるときだけ比率を保って縮小する", () => {
    const result = fitSize(4096, 2048);
    expect(result.width).toBe(UNDERLAY_MAX_EDGE);
    expect(result.height).toBe(Math.round((UNDERLAY_MAX_EDGE / 4096) * 2048));
  });

  it("縦長画像でも比率を保つ", () => {
    const result = fitSize(1000, 4000);
    expect(result.height).toBe(UNDERLAY_MAX_EDGE);
    expect(result.width).toBe(Math.round((UNDERLAY_MAX_EDGE / 4000) * 1000));
  });
});

describe("fitPlacement", () => {
  it("横長画像は幅いっぱいに収まり中央寄せされる", () => {
    // キャンバスより極端に横長 → 幅基準で contain
    const placement = fitPlacement(3496, 1181 / 2);
    expect(placement.scale).toBeCloseTo(CANVAS_WIDTH / 3496);
    const scaledHeight = (1181 / 2) * placement.scale;
    expect(placement.ty).toBeCloseTo((CANVAS_HEIGHT - scaledHeight) / 2);
    expect(placement.tx).toBeCloseTo(0);
  });

  it("縦長画像は高さいっぱいに収まり中央寄せされる", () => {
    const placement = fitPlacement(1748 / 2, 2362);
    expect(placement.scale).toBeCloseTo(CANVAS_HEIGHT / 2362);
    const scaledWidth = (1748 / 2) * placement.scale;
    expect(placement.tx).toBeCloseTo((CANVAS_WIDTH - scaledWidth) / 2);
    expect(placement.ty).toBeCloseTo(0);
  });

  it("画像全体が必ず収まる(はみ出さない)", () => {
    const placement = fitPlacement(500, 3000);
    const scaledWidth = 500 * placement.scale;
    const scaledHeight = 3000 * placement.scale;
    expect(scaledWidth).toBeLessThanOrEqual(CANVAS_WIDTH + 0.001);
    expect(scaledHeight).toBeLessThanOrEqual(CANVAS_HEIGHT + 0.001);
  });
});

describe("clampPlacement", () => {
  const width = 1000;
  const height = 800;
  const fit = fitPlacement(width, height);

  it("倍率を fit 基準の範囲内に丸める", () => {
    const tooSmall = clampPlacement({ scale: fit.scale * 0.01, tx: fit.tx, ty: fit.ty }, width, height);
    expect(tooSmall.scale).toBeCloseTo(fit.scale * UNDERLAY_MIN_SCALE_RATIO);

    const tooBig = clampPlacement({ scale: fit.scale * 100, tx: fit.tx, ty: fit.ty }, width, height);
    expect(tooBig.scale).toBeCloseTo(fit.scale * UNDERLAY_MAX_SCALE_RATIO);
  });

  it("範囲内の倍率はそのまま", () => {
    const ok = clampPlacement({ scale: fit.scale * 2, tx: 0, ty: 0 }, width, height);
    expect(ok.scale).toBeCloseTo(fit.scale * 2);
  });

  it("紙から完全に外れる tx/ty を引き戻す(紙の1/4以上が重なるところまで)", () => {
    const scaledWidth = width * fit.scale;
    const scaledHeight = height * fit.scale;
    const requiredX = Math.min(CANVAS_WIDTH / 4, scaledWidth);
    const requiredY = Math.min(CANVAS_HEIGHT / 4, scaledHeight);

    const farRight = clampPlacement({ scale: fit.scale, tx: CANVAS_WIDTH + 5000, ty: 0 }, width, height);
    expect(farRight.tx).toBeCloseTo(CANVAS_WIDTH - requiredX);

    const farLeft = clampPlacement({ scale: fit.scale, tx: -100000, ty: 0 }, width, height);
    expect(farLeft.tx).toBeCloseTo(requiredX - scaledWidth);

    const farDown = clampPlacement({ scale: fit.scale, tx: 0, ty: CANVAS_HEIGHT + 5000 }, width, height);
    expect(farDown.ty).toBeCloseTo(CANVAS_HEIGHT - requiredY);

    // 完全に外れる位置(紙の矩形と全く重ならない遠い場所)を渡しても、
    // 引き戻された結果は必ず紙の矩形と 1/4 以上重なる。
    const farAway = clampPlacement({ scale: fit.scale, tx: 999999, ty: 999999 }, width, height);
    const overlapX = Math.min(farAway.tx + scaledWidth, CANVAS_WIDTH) - Math.max(farAway.tx, 0);
    const overlapY = Math.min(farAway.ty + scaledHeight, CANVAS_HEIGHT) - Math.max(farAway.ty, 0);
    expect(overlapX).toBeGreaterThanOrEqual(requiredX - 0.001);
    expect(overlapY).toBeGreaterThanOrEqual(requiredY - 0.001);
  });

  it("下敷きが小さくて紙の1/4に届かない場合は、下敷き全体ぶんを下限にする", () => {
    // 紙の 1/4 よりずっと小さい下敷き(fit の 0.1 倍程度)。
    const tinyScale = fit.scale * UNDERLAY_MIN_SCALE_RATIO;
    const scaledWidth = width * tinyScale;
    expect(scaledWidth).toBeLessThan(CANVAS_WIDTH / 4);

    const farRight = clampPlacement({ scale: tinyScale, tx: CANVAS_WIDTH + 5000, ty: 0 }, width, height);
    // 下限は「下敷きの幅ぶん」= 右端が紙の右端に一致する位置まで。
    expect(farRight.tx).toBeCloseTo(CANVAS_WIDTH - scaledWidth);

    const farLeft = clampPlacement({ scale: tinyScale, tx: -100000, ty: 0 }, width, height);
    expect(farLeft.tx).toBeCloseTo(0);
  });

  it("紙と重なっている位置は動かさない", () => {
    const inside = clampPlacement({ scale: fit.scale, tx: 10, ty: 20 }, width, height);
    expect(inside.tx).toBeCloseTo(10);
    expect(inside.ty).toBeCloseTo(20);
  });
});

describe("scaleAt", () => {
  it("anchor 点を固定したまま拡大する(キャンバス座標→画像内座標が変わらない)", () => {
    const width = 1000;
    const height = 800;
    const placement = fitPlacement(width, height);
    const anchorX = CANVAS_WIDTH / 2;
    const anchorY = CANVAS_HEIGHT / 2;

    const imageXBefore = (anchorX - placement.tx) / placement.scale;
    const imageYBefore = (anchorY - placement.ty) / placement.scale;

    const scaled = scaleAt(placement, width, height, anchorX, anchorY, 2);

    const imageXAfter = (anchorX - scaled.tx) / scaled.scale;
    const imageYAfter = (anchorY - scaled.ty) / scaled.scale;

    expect(imageXAfter).toBeCloseTo(imageXBefore);
    expect(imageYAfter).toBeCloseTo(imageYBefore);
    expect(scaled.scale).toBeCloseTo(placement.scale * 2);
  });
});

describe("createUnderlay", () => {
  it("初期値は既定の濃さ・fitPlacement と一致する配置", () => {
    const underlay = createUnderlay(dummy, 1000, 800, 1234, dummyThumb);
    expect(underlay.opacity).toBe(DEFAULT_UNDERLAY_OPACITY);
    expect(underlay.placement).toEqual(fitPlacement(1000, 800));
    expect(underlay.width).toBe(1000);
    expect(underlay.height).toBe(800);
    expect(underlay.createdAt).toBe(1234);
    expect(underlay.id.startsWith("under-")).toBe(true);
  });

  it("lastUsedAt は取り込んだ時刻(now)になる(取り込んだ直後は「今使った」ため)", () => {
    const underlay = createUnderlay(dummy, 1000, 800, 1234, dummyThumb);
    expect(underlay.lastUsedAt).toBe(1234);
  });
});

describe("pickEvicted", () => {
  it("上限以内なら空配列", () => {
    const records = [
      { id: "a", lastUsedAt: 1 },
      { id: "b", lastUsedAt: 2 },
    ];
    expect(pickEvicted(records, 2)).toEqual([]);
    expect(pickEvicted(records, 10)).toEqual([]);
  });

  it("上限を超えたぶんだけ lastUsedAt の古い順に返す", () => {
    const records = [
      { id: "a", lastUsedAt: 30 },
      { id: "b", lastUsedAt: 10 },
      { id: "c", lastUsedAt: 20 },
    ];
    expect(pickEvicted(records, 2)).toEqual(["b"]);
    expect(pickEvicted(records, 1)).toEqual(["b", "c"]);
  });

  it("既定値は MAX_UNDERLAYS", () => {
    const records = Array.from({ length: MAX_UNDERLAYS + 2 }, (_, i) => ({ id: `id${i}`, lastUsedAt: i }));
    expect(pickEvicted(records)).toEqual(["id0", "id1"]);
  });

  it("lastUsedAt が同点なら id 順で決着させ、結果が揺れないようにする", () => {
    const records = [
      { id: "b", lastUsedAt: 10 },
      { id: "a", lastUsedAt: 10 },
      { id: "c", lastUsedAt: 10 },
    ];
    expect(pickEvicted(records, 1)).toEqual(["a", "b"]);
  });
});

describe("MemoryUnderlayStore", () => {
  it("put/list は createdAt の新しい順で全件返す", async () => {
    const store = new MemoryUnderlayStore();
    const older = createUnderlay(dummy, 100, 100, 10, dummyThumb);
    const newer = createUnderlay(dummy, 100, 100, 20, dummyThumb);
    await store.put(older);
    await store.put(newer);
    expect((await store.list()).map((u) => u.id)).toEqual([newer.id, older.id]);
  });

  it("remove すると一覧からも get からも消える", async () => {
    const store = new MemoryUnderlayStore();
    const underlay = createUnderlay(dummy, 100, 100, 10, dummyThumb);
    await store.put(underlay);

    expect(await store.remove(underlay.id)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.get(underlay.id)).toBeNull();
  });

  it("知らない ID なら false を返すだけ(落とさない)", async () => {
    expect(await new MemoryUnderlayStore().remove("nope")).toBe(false);
  });
});

describe("pruneUnderlays", () => {
  it("上限まで減り、残るのは lastUsedAt の新しい側", async () => {
    const store = new MemoryUnderlayStore();
    const max = 3;
    const records = Array.from({ length: max + 2 }, (_, i) => createUnderlay(dummy, 100, 100, i, dummyThumb));
    for (const record of records) {
      await store.put(record);
    }

    const prunedCount = await pruneUnderlays(store, max);
    expect(prunedCount).toBe(2);

    const remaining = await store.list();
    expect(remaining).toHaveLength(max);
    // createdAt(=lastUsedAt の初期値)が新しい 3 件だけ残る。
    const remainingCreatedAt = remaining.map((r) => r.createdAt).sort((a, b) => a - b);
    expect(remainingCreatedAt).toEqual([2, 3, 4]);
  });

  it("上限以内なら何も消さない", async () => {
    const store = new MemoryUnderlayStore();
    await store.put(createUnderlay(dummy, 100, 100, 1, dummyThumb));
    expect(await pruneUnderlays(store, 5)).toBe(0);
    expect(await store.list()).toHaveLength(1);
  });
});
