// コマの保存(版ストア)。docs/page-versions.md 参照。
//
// IndexedDB を直接は触らない純粋な関数だけを置く。分解(splitWork)・組み立て(joinWork)・
// 古い形の読み込み(assignLegacyVersionIds)・掃除の判断(unreferencedVersionIds)を
// vitest だけで固めるため(vitest には IndexedDB が無い)。
import { createId, type LayerData, type PageData, type WorkRecord, type WorkSnapshot } from "./model.ts";
import { isFrameData, type FrameData } from "./frame.ts";

/** 封筒(StoredEnvelope.version)の値。版を別の箱に置く形。 */
export const ENVELOPE_VERSION = 2;

/**
 * 掃除(unreferencedVersionIds)が版を消してよくなるまでの猶予。
 * 別のタブ・別のアプリが同じ作品を同時に保存したときの保険(docs 参照)。
 */
export const VERSION_GC_GRACE_MS = 10 * 60 * 1000;

/** あるページのある時点の絵。一度書いたら書き換えない。 */
export interface PageVersion {
  versionId: string;
  workId: string;
  pageId: string;
  image: Blob;
  layers: LayerData[];
  activeLayerId?: string;
  /**
   * わく(コマ割り)は版の側に持つ: お手本を変えると絵を焼き直して新しい版になるので、
   * 絵と同じ単位で持つ(docs/manga.md)。
   */
  frame?: FrameData;
  createdAt: number;
}

/** 作品の行が持つページの参照。画像そのものではなく versionId だけを持つ。 */
export interface StoredPageRef {
  id: string;
  deleted: boolean;
  versionId: string;
}

/** WorkSnapshot の pages を StoredPageRef[] に差し替えたもの。 */
export interface StoredSnapshot {
  id: string;
  createdAt: number;
  pages: StoredPageRef[];
  thumbnail?: Blob;
  reason: WorkSnapshot["reason"];
}

/** WorkRecord の pages/snapshots を版参照に差し替えたもの(封筒 2 の中身)。 */
export interface StoredWork {
  id: string;
  createdAt: number;
  updatedAt: number;
  markId: string | null;
  deleted: boolean;
  canvasWidth: number;
  canvasHeight: number;
  paperKind: WorkRecord["paperKind"];
  pages: StoredPageRef[];
  thumbnail?: Blob;
  snapshots: StoredSnapshot[];
  animation: boolean;
  activePageId?: string;
}

function pageToRef(page: PageData): StoredPageRef {
  return { id: page.id, deleted: page.deleted, versionId: page.versionId };
}

function pageToVersion(workId: string, page: PageData, now: number): PageVersion {
  return {
    versionId: page.versionId,
    workId,
    pageId: page.id,
    image: page.image,
    layers: page.layers,
    ...(page.activeLayerId === undefined ? {} : { activeLayerId: page.activeLayerId }),
    ...(page.frame === undefined ? {} : { frame: page.frame }),
    createdAt: now,
  };
}

/**
 * 作品を「作品の行」と「版の一覧」に分解する。
 * 今のページと全控えのページから版を集めるので、同じ versionId が複数回出てくる
 * (控えが今のページと同じ絵を指している等)。versionId で重複排除し、最初に
 * 出てきたものを残す(書き込みの順番§1「まだ無いものだけ add」で使う一覧なので、
 * 同じ versionId は 1 つあれば足りる)。
 */
export function splitWork(work: WorkRecord, now: number): { stored: StoredWork; versions: PageVersion[] } {
  const versions = new Map<string, PageVersion>();
  for (const page of work.pages) {
    if (!versions.has(page.versionId)) versions.set(page.versionId, pageToVersion(work.id, page, now));
  }
  for (const snapshot of work.snapshots) {
    for (const page of snapshot.pages) {
      if (!versions.has(page.versionId)) versions.set(page.versionId, pageToVersion(work.id, page, now));
    }
  }

  const stored: StoredWork = {
    id: work.id,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    markId: work.markId,
    deleted: work.deleted,
    canvasWidth: work.canvasWidth,
    canvasHeight: work.canvasHeight,
    paperKind: work.paperKind,
    pages: work.pages.map(pageToRef),
    ...(work.thumbnail === undefined ? {} : { thumbnail: work.thumbnail }),
    animation: work.animation,
    ...(work.activePageId === undefined ? {} : { activePageId: work.activePageId }),
    snapshots: work.snapshots.map((snapshot) => ({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      pages: snapshot.pages.map(pageToRef),
      ...(snapshot.thumbnail === undefined ? {} : { thumbnail: snapshot.thumbnail }),
      reason: snapshot.reason,
    })),
  };
  return { stored, versions: [...versions.values()] };
}

function refToPage(ref: StoredPageRef, version: PageVersion): PageData {
  // 読めない frame で描画が壊れないよう、isFrameData で確かめて外れていたら落とす
  // (unwrap() の layers 補完と同じ考え方)。
  const frame = isFrameData(version.frame) ? version.frame : undefined;
  return {
    id: ref.id,
    deleted: ref.deleted,
    versionId: ref.versionId,
    image: version.image,
    layers: version.layers,
    ...(version.activeLayerId === undefined ? {} : { activeLayerId: version.activeLayerId }),
    ...(frame === undefined ? {} : { frame }),
  };
}

/**
 * ページの参照一覧を、版が全部揃っているときだけ PageData[] に組み立てる。
 * 1 つでも欠けていたら null(呼び出し側で「この控えは落とす」等に使う)。
 */
function joinPages(refs: readonly StoredPageRef[], versions: ReadonlyMap<string, PageVersion>): PageData[] | null {
  const pages: PageData[] = [];
  for (const ref of refs) {
    const version = versions.get(ref.versionId);
    if (version === undefined) return null;
    pages.push(refToPage(ref, version));
  }
  return pages;
}

/**
 * 作品の行 + 版から作品を組み立てる。docs「版が欠けていたとき」の規則どおり:
 * - 控えの版が 1 つでも欠けていたら、その控えだけ落とす(他の控えは活かす)
 * - 今のページの版が欠けていたら、版が揃っているいちばん新しい(createdAt 最大の)
 *   控えの pages を今の pages として読む(＝直前に確実だった姿まで戻す)
 * - それも無ければ読まない(今の「壊れたデータ」と同じ扱い)
 */
export function joinWork(stored: StoredWork, versions: ReadonlyMap<string, PageVersion>): WorkRecord | null {
  const snapshots: WorkSnapshot[] = [];
  let fallbackPages: PageData[] | null = null;
  let fallbackCreatedAt = -Infinity;
  for (const storedSnapshot of stored.snapshots) {
    const pages = joinPages(storedSnapshot.pages, versions);
    if (pages === null) continue;
    snapshots.push({
      id: storedSnapshot.id,
      createdAt: storedSnapshot.createdAt,
      pages,
      ...(storedSnapshot.thumbnail === undefined ? {} : { thumbnail: storedSnapshot.thumbnail }),
      reason: storedSnapshot.reason,
    });
    if (storedSnapshot.createdAt > fallbackCreatedAt) {
      fallbackCreatedAt = storedSnapshot.createdAt;
      fallbackPages = pages;
    }
  }

  const pages = joinPages(stored.pages, versions) ?? fallbackPages;
  if (pages === null) return null;

  return {
    id: stored.id,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    markId: stored.markId,
    deleted: stored.deleted,
    canvasWidth: stored.canvasWidth,
    canvasHeight: stored.canvasHeight,
    paperKind: stored.paperKind,
    pages,
    ...(stored.thumbnail === undefined ? {} : { thumbnail: stored.thumbnail }),
    animation: stored.animation,
    // pages が控えから補われた場合でも activePageId はそのまま渡す。
    // 「見つからなければ 1 コマ目」の判断は使う側(main.ts)の仕事にする。
    ...(stored.activePageId === undefined ? {} : { activePageId: stored.activePageId }),
    snapshots,
  };
}

/** 2 ページが同じ Blob を共有していたかどうか(古い形を畳むときの判定)。 */
function sameContent(a: PageData, b: PageData): boolean {
  if (a.image !== b.image) return false;
  if (a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i += 1) {
    if (a.layers[i]?.image !== b.layers[i]?.image) return false;
  }
  return a.activeLayerId === b.activeLayerId;
}

/**
 * 古い形(封筒 1)を読んだ作品に versionId を振り直す。
 *
 * 既に versionId が入っていても無視して必ず新しく振る。古いコードが同じ作品を
 * 封筒 1 で上書きし直すことがあり、そのとき「同じ ID なのに中身が違う」版が
 * できてしまうため(docs「版 ID の規則」参照。重複は次の保存の掃除で消えるので害は無い)。
 *
 * 同じ Blob を共有していたページ(今のページと控え、控え同士)は 1 つの版に畳む。
 * 畳まないと、古い形の作品を読み込むたびに同じ絵が別の版として増え続けてしまう。
 */
export function assignLegacyVersionIds(work: WorkRecord): WorkRecord {
  const seen: PageData[] = [];
  const ids = new Map<PageData, string>();

  function versionIdFor(page: PageData): string {
    const existing = seen.find((other) => sameContent(other, page));
    if (existing !== undefined) return ids.get(existing)!;
    const id = createId("ver");
    seen.push(page);
    ids.set(page, id);
    return id;
  }

  return {
    ...work,
    pages: work.pages.map((page) => ({ ...page, versionId: versionIdFor(page) })),
    snapshots: work.snapshots.map((snapshot) => ({
      ...snapshot,
      pages: snapshot.pages.map((page) => ({ ...page, versionId: versionIdFor(page) })),
    })),
  };
}

/** 作品の行(今のページ・控え)がどこかで指している versionId の集合。 */
export function referencedVersionIds(stored: StoredWork): Set<string> {
  const ids = new Set<string>();
  for (const ref of stored.pages) ids.add(ref.versionId);
  for (const snapshot of stored.snapshots) {
    for (const ref of snapshot.pages) ids.add(ref.versionId);
  }
  return ids;
}

/**
 * どこからも指されておらず、かつ作られてから graceMs 以上経っている版だけを返す。
 * 10 分未満の版を対象外にするのは、別のタブ・別のアプリが同時に保存したときに
 * 足したばかりの版を消してしまわないための保険(docs「書き込みの順番」参照)。
 */
export function unreferencedVersionIds(
  stored: StoredWork,
  existing: readonly { versionId: string; createdAt: number }[],
  now: number,
  graceMs = VERSION_GC_GRACE_MS,
): string[] {
  const referenced = referencedVersionIds(stored);
  return existing
    .filter((version) => !referenced.has(version.versionId) && now - version.createdAt >= graceMs)
    .map((version) => version.versionId);
}
