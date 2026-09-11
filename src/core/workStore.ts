// 作品ストアの永続化。docs/page-versions.md「手順 2」。
//
// 作品の行(封筒 1 or 2)は既存の `iroha-paint`/`works` に置いたまま、絵そのもの(版)は
// 新しい `iroha-pages`/`versions` に別で置く。分解(splitWork)・組み立て(joinWork)・
// 掃除の判断(unreferencedVersionIds)は pageVersions.ts の純粋関数を使い、ここでは
// IndexedDB とのやり取りだけを行う。Blob は IndexedDB がそのまま格納できる
// (structured clone)ので、PNG を base64 化するような無駄な変換はしない。
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  defaultLayers,
  SCHEMA_VERSION,
  type PageData,
  type WorkRecord,
} from "./model.ts";
import { isPaperKind } from "./paper.ts";
import {
  assignLegacyVersionIds,
  ENVELOPE_VERSION,
  joinWork,
  referencedVersionIds,
  splitWork,
  VERSION_GC_GRACE_MS,
  type PageVersion,
  type StoredPageRef,
  type StoredSnapshot,
  type StoredWork,
} from "./pageVersions.ts";

export interface StoredEnvelope {
  version: number;
  work: WorkRecord;
}

export interface WorkStore {
  /** 作品を保存(上書き)する。 */
  put(work: WorkRecord): Promise<void>;
  /** 削除フラグの立っていない作品を updatedAt の新しい順で返す。 */
  list(): Promise<WorkRecord[]>;
  /** ゴミばこの中身(削除フラグが立っているもの)。 */
  listDeleted(): Promise<WorkRecord[]>;
  get(id: string): Promise<WorkRecord | null>;
  /**
   * 「すてる」/「とりもどす」。レコードは決して消さない(仕様書§7.5 消えない設計)。
   * 見つからなければ false。
   */
  setDeleted(id: string, deleted: boolean): Promise<boolean>;
}

/** テスト用。IndexedDbWorkStore と同じ振る舞いを満たす。 */
export class MemoryWorkStore implements WorkStore {
  private readonly records = new Map<string, WorkRecord>();

  async put(work: WorkRecord): Promise<void> {
    this.records.set(work.id, work);
  }

  async list(): Promise<WorkRecord[]> {
    return [...this.records.values()]
      .filter((work) => !work.deleted)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listDeleted(): Promise<WorkRecord[]> {
    return [...this.records.values()]
      .filter((work) => work.deleted)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<WorkRecord | null> {
    return this.records.get(id) ?? null;
  }

  async setDeleted(id: string, deleted: boolean): Promise<boolean> {
    const work = this.records.get(id);
    if (work === undefined) return false;
    this.records.set(id, { ...work, deleted });
    return true;
  }
}

// 公開前に名称が「いろは」に決まったので DB 名も合わせる。
// 未公開＝実ユーザーのデータが無いうちにしか変えられない(変えると旧 DB は参照されなくなる)。
const DB_NAME = "iroha-paint";
const DB_VERSION = 1;
const STORE_NAME = "works";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "work.id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 版を置く新しい箱(docs/page-versions.md「形」参照)。iroha-paint とは別 DB にして、
// 作品側の DB_VERSION を上げずに済ませる(古いコードが開けなくなるのを避けるため)。
const PAGES_DB_NAME = "iroha-pages";
const PAGES_DB_VERSION = 1;
const VERSIONS_STORE_NAME = "versions";
const VERSIONS_WORKID_INDEX = "workId";

function openPagesDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PAGES_DB_NAME, PAGES_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VERSIONS_STORE_NAME)) {
        const store = db.createObjectStore(VERSIONS_STORE_NAME, { keyPath: "versionId" });
        store.createIndex(VERSIONS_WORKID_INDEX, "workId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * バージョン不一致・壊れたレコードは無視する(復元に失敗しても起動はする)。
 *
 * canvasWidth/canvasHeight・pages[].deleted・paperKind・pages[].layers は後から足した
 * フィールドなので、古い保存データには入っていない。SCHEMA_VERSION を上げて古い作品ごと
 * 捨てるようなことは絶対にしない(子どもの絵なので)。代わりにここで欠けている分だけ
 * 補う。今ある保存データは全部 CANVAS_WIDTH x CANVAS_HEIGHT・"plain" で描かれたものなので、
 * その値で補って正しい。deleted も未指定なら「消していない」で正しい。
 * paperKind は不正な値(壊れたデータ・型が合わないもの)でも "plain" に落とす。
 * layers が無い・配列でない・空の場合は defaultLayers() で「合成結果(page.image)を
 * 唯一のレイヤーとする」形に補う。安定 id(ページ id から作る)なので、何度読み込んでも
 * 同じ id になる。
 *
 * 読むのは封筒 1(丸ごと形)だけ。封筒 2(版を別に置く形)は readRow() が扱う。
 */
export function unwrap(raw: unknown): WorkRecord | null {
  const envelope = raw as StoredEnvelope | undefined;
  if (envelope === undefined) return null;
  if (envelope.version !== SCHEMA_VERSION) return null;
  const work = envelope.work;
  if (work === undefined || work === null) return null;
  if (typeof work.id !== "string" || !Array.isArray(work.pages)) return null;
  const completed: WorkRecord = {
    ...work,
    canvasWidth: work.canvasWidth ?? CANVAS_WIDTH,
    canvasHeight: work.canvasHeight ?? CANVAS_HEIGHT,
    paperKind: isPaperKind(work.paperKind) ? work.paperKind : "plain",
    pages: work.pages.map((page: PageData) => ({
      ...page,
      deleted: page.deleted ?? false,
      layers: Array.isArray(page.layers) && page.layers.length > 0 ? page.layers : defaultLayers(page.id, page.image),
    })),
  };
  // 封筒 1(この関数が読む唯一の形)は読むたびに versionId を振り直す
  // (docs/page-versions.md「版 ID の規則」参照。封筒 2 の読み込みは readRow() が扱う)。
  return assignLegacyVersionIds(completed);
}

/** readRow() が返す、1 行ぶんの読み取り結果。 */
export type ReadRowResult = { kind: "legacy"; work: WorkRecord } | { kind: "stored"; stored: StoredWork } | null;

function isStoredPageRefs(value: unknown): value is StoredPageRef[] {
  return Array.isArray(value) && value.every((ref) => typeof (ref as StoredPageRef)?.versionId === "string");
}

/**
 * 封筒 2(work.pages/work.snapshots が versionId だけを持つ形)の中身を確かめて補う。
 * unwrap() と同じ規則で canvasWidth/canvasHeight/paperKind の欠けを補う
 * (封筒 2 を書き始めた時点ではまだこれらのフィールドは欠けていないはずだが、
 * 将来また項目が増えたときのために同じ作法を通しておく)。壊れていれば null。
 */
function readStoredWork(raw: unknown): StoredWork | null {
  const work = raw as Partial<StoredWork> | undefined;
  if (work === undefined || work === null) return null;
  if (typeof work.id !== "string" || !Array.isArray(work.pages) || !Array.isArray(work.snapshots)) return null;
  if (!isStoredPageRefs(work.pages)) return null;
  for (const snapshot of work.snapshots as StoredSnapshot[]) {
    if (typeof snapshot !== "object" || snapshot === null || !isStoredPageRefs(snapshot.pages)) return null;
  }
  return {
    ...work,
    canvasWidth: work.canvasWidth ?? CANVAS_WIDTH,
    canvasHeight: work.canvasHeight ?? CANVAS_HEIGHT,
    paperKind: isPaperKind(work.paperKind) ? work.paperKind : "plain",
  } as StoredWork;
}

/**
 * works から読んだ 1 行を、封筒の種類で振り分ける。
 * version === SCHEMA_VERSION(=1) なら封筒 1(丸ごと形。unwrap() を通す)、
 * version === ENVELOPE_VERSION(=2) なら封筒 2(版は別の箱。readStoredWork() で確かめる)、
 * それ以外は壊れたデータとして null(今までどおり読まない)。
 */
export function readRow(raw: unknown): ReadRowResult {
  const envelope = raw as { version?: number; work?: unknown } | undefined;
  if (envelope === undefined || envelope === null) return null;
  if (envelope.version === SCHEMA_VERSION) {
    const work = unwrap(raw);
    return work === null ? null : { kind: "legacy", work };
  }
  if (envelope.version === ENVELOPE_VERSION) {
    const stored = readStoredWork(envelope.work);
    return stored === null ? null : { kind: "stored", stored };
  }
  return null;
}

export class IndexedDbWorkStore implements WorkStore {
  // put/get/list/listDeleted/setDeleted は 1 本のキューで直列化する
  // (docs/page-versions.md「書き込みの順番」: 自動保存と控えの撮影が重なると、
  // 片方の掃除がもう片方が足したばかりの版を消しうるため)。1 つ失敗しても
  // 後続はそのまま流れるよう、キュー自体は catch して繋ぎ直す。
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async put(work: WorkRecord): Promise<void> {
    return this.enqueue(() => this.putInternal(work));
  }

  async get(id: string): Promise<WorkRecord | null> {
    return this.enqueue(() => this.getInternal(id));
  }

  async list(): Promise<WorkRecord[]> {
    return this.enqueue(() => this.query((work) => !work.deleted));
  }

  async listDeleted(): Promise<WorkRecord[]> {
    return this.enqueue(() => this.query((work) => work.deleted));
  }

  async setDeleted(id: string, deleted: boolean): Promise<boolean> {
    // get→put は内部の非キュー版を使う(キュー版を呼ぶとキューの中からキューを
    // 待つことになりデッドロックする)。
    return this.enqueue(() => this.setDeletedInternal(id, deleted));
  }

  private async setDeletedInternal(id: string, deleted: boolean): Promise<boolean> {
    const work = await this.getInternal(id);
    if (work === null) return false;
    await this.putInternal({ ...work, deleted });
    return true;
  }

  private async putInternal(work: WorkRecord): Promise<void> {
    const now = Date.now();
    const { stored, versions } = splitWork(work, now);

    // 1. iroha-pages にまだ無い版だけ足す。ここが失敗したら(箱が開けない等)
    //    作品そのものは従来どおり丸ごと形で保存し、保存自体は失敗させない。
    const versionsSaved = await this.tryAddVersions(versions);
    if (!versionsSaved) {
      console.warn("iroha-pages への書き込みに失敗したため、作品を丸ごと形(封筒 1)で保存する");
      await this.putEnvelope({ version: SCHEMA_VERSION, work });
      return;
    }

    // 2. 作品の行は封筒 2(版参照だけ)で保存する。これでどこからも指されない版が
    //    確定するので、3 の掃除を安全に行える。
    await this.putEnvelope({ version: ENVELOPE_VERSION, work: stored });

    // 3. 使われなくなった版を掃除する。ここで失敗してもデータは既に安全なので
    //    保存自体は成功として扱う(次回の保存でまた掃除の機会がある)。
    try {
      await this.cleanupVersions(stored, now);
    } catch (error) {
      console.warn("使われなくなった版の掃除に失敗した(保存自体は成功している)", error);
    }
  }

  /**
   * versions のうちまだ無いものだけを 1 トランザクションで add する。
   * getKey → (無ければ)add をリクエストのコールバックの中で連ねる形で書く。
   * トランザクションの途中で IndexedDB 以外の Promise を await すると自動コミット
   * されてしまうため、ここでは await を使わない。
   */
  private tryAddVersions(versions: readonly PageVersion[]): Promise<boolean> {
    return new Promise((resolve) => {
      openPagesDb().then(
        (db) => {
          let tx: IDBTransaction;
          try {
            tx = db.transaction(VERSIONS_STORE_NAME, "readwrite");
          } catch {
            db.close();
            resolve(false);
            return;
          }
          const store = tx.objectStore(VERSIONS_STORE_NAME);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            resolve(false);
          };
          tx.onabort = () => {
            db.close();
            resolve(false);
          };
          for (const version of versions) {
            const keyRequest = store.getKey(version.versionId);
            keyRequest.onsuccess = () => {
              if (keyRequest.result === undefined) store.add(version);
            };
            // getKey 個別の onerror は拾わない。トランザクション全体を
            // tx.onerror でまとめて失敗扱いにする(1 つでもおかしければ丸ごと形に倒す)。
          }
        },
        () => resolve(false),
      );
    });
  }

  private async putEnvelope(envelope: { version: number; work: WorkRecord | StoredWork }): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      await promisify(tx.objectStore(STORE_NAME).put(envelope));
    } finally {
      db.close();
    }
  }

  /**
   * どこからも指されておらず、作られて 10 分以上経っている版を削除する。
   * 索引 workId のカーソルで versionId/createdAt だけ見て判定するので、
   * 版の Blob(画像)は読み込まない。
   */
  private async cleanupVersions(stored: StoredWork, now: number): Promise<void> {
    const db = await openPagesDb();
    try {
      const referenced = referencedVersionIds(stored);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(VERSIONS_STORE_NAME, "readwrite");
        const index = tx.objectStore(VERSIONS_STORE_NAME).index(VERSIONS_WORKID_INDEX);
        const request = index.openCursor(IDBKeyRange.only(stored.id));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          const version = cursor.value as PageVersion;
          if (!referenced.has(version.versionId) && now - version.createdAt >= VERSION_GC_GRACE_MS) {
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  /** iroha-pages から、ある workId の版だけを versionId → 版 の Map で読む。 */
  private async readVersionsFor(workId: string): Promise<Map<string, PageVersion>> {
    const db = await openPagesDb();
    try {
      const tx = db.transaction(VERSIONS_STORE_NAME, "readonly");
      const index = tx.objectStore(VERSIONS_STORE_NAME).index(VERSIONS_WORKID_INDEX);
      const rows = await promisify(index.getAll(IDBKeyRange.only(workId)));
      return new Map((rows as PageVersion[]).map((version) => [version.versionId, version]));
    } finally {
      db.close();
    }
  }

  /** iroha-pages の versions を 1 回の getAll で読み、versionId → 版 の Map にする。 */
  private async readAllVersions(): Promise<Map<string, PageVersion>> {
    const db = await openPagesDb();
    try {
      const tx = db.transaction(VERSIONS_STORE_NAME, "readonly");
      const rows = await promisify(tx.objectStore(VERSIONS_STORE_NAME).getAll());
      return new Map((rows as PageVersion[]).map((version) => [version.versionId, version]));
    } finally {
      db.close();
    }
  }

  private async getInternal(id: string): Promise<WorkRecord | null> {
    const db = await openDb();
    let raw: unknown;
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      raw = await promisify(tx.objectStore(STORE_NAME).get(id));
    } finally {
      db.close();
    }
    const row = readRow(raw);
    if (row === null) return null;
    if (row.kind === "legacy") return row.work;
    const versions = await this.readVersionsFor(row.stored.id);
    return joinWork(row.stored, versions);
  }

  private async query(keep: (work: WorkRecord) => boolean): Promise<WorkRecord[]> {
    const db = await openDb();
    let rawRows: unknown[];
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      rawRows = await promisify(tx.objectStore(STORE_NAME).getAll());
    } finally {
      db.close();
    }

    const rows = rawRows.map(readRow).filter((row): row is Exclude<ReadRowResult, null> => row !== null);
    const legacyWorks = rows
      .filter((row): row is { kind: "legacy"; work: WorkRecord } => row.kind === "legacy")
      .map((row) => row.work);
    const storedRows = rows.filter((row): row is { kind: "stored"; stored: StoredWork } => row.kind === "stored");

    let joinedWorks: WorkRecord[] = [];
    if (storedRows.length > 0) {
      const versions = await this.readAllVersions();
      joinedWorks = storedRows
        .map((row) => joinWork(row.stored, versions))
        .filter((work): work is WorkRecord => work !== null);
    }

    return [...legacyWorks, ...joinedWorks].filter(keep).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/**
 * 保存領域を「消えにくい」扱いにするよう頼む。
 * Safari は使われていないサイトのデータを一定期間で消すことがあり、
 * 学童の共用 iPad のように「たまにしか開かない」使い方だと作品ごと消えかねない。
 * 断られても描くことには影響しないので、結果は握りつぶす。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist === undefined) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** IndexedDB が使えない環境(プライベートブラウズ等)ではメモリに落とす。 */
export function createWorkStore(): WorkStore {
  if (typeof indexedDB === "undefined") return new MemoryWorkStore();
  return new IndexedDbWorkStore();
}
