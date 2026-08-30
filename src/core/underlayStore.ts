// 下敷きストアの永続化。IndexedDB に下敷きレコードをそのまま入れる。
// Blob は IndexedDB がそのまま格納できる(structured clone)ので、
// 画像を base64 化するような無駄な変換はしない(workStore.ts と同じ考え方)。
//
// DB は作品ストア(iroha-paint)とは別にする。理由は 2 つ:
//   (1) 下敷きは作品ではないので、作品ストアに入れない＝取り込んだ画像が
//       編集可能な作品になる経路が構造的に存在しない。
//   (2) DB を分ければ片方のスキーマ変更がもう片方の onupgradeneeded に影響しない。
//
// 作品(WorkRecord)はソフトデリート(「消えない設計」)だが、下敷きは本当に削除する。
// 作品は子どもが描いたものそのものだが、下敷きは取り込んだ画像の複製に過ぎず、
// 元ファイルは手元に残っているので消したければ取り込み直せばよい。むしろ写真は
// 数 MB あるため、消したつもりのものが残り続けると端末の容量を圧迫する。
import { MAX_UNDERLAYS, pickEvicted, type UnderlayRecord, UNDERLAY_SCHEMA_VERSION } from "./underlay.ts";

export interface StoredEnvelope {
  version: number;
  underlay: UnderlayRecord;
}

export interface UnderlayStore {
  /** 下敷きを保存(上書き)する。 */
  put(underlay: UnderlayRecord): Promise<void>;
  /** 下敷きを createdAt の新しい順で全件返す。 */
  list(): Promise<UnderlayRecord[]>;
  get(id: string): Promise<UnderlayRecord | null>;
  /** 本当に削除する。見つからなければ false。 */
  remove(id: string): Promise<boolean>;
}

/** テスト用。IndexedDbUnderlayStore と同じ振る舞いを満たす。 */
export class MemoryUnderlayStore implements UnderlayStore {
  private readonly records = new Map<string, UnderlayRecord>();

  async put(underlay: UnderlayRecord): Promise<void> {
    this.records.set(underlay.id, underlay);
  }

  async list(): Promise<UnderlayRecord[]> {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<UnderlayRecord | null> {
    return this.records.get(id) ?? null;
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

const DB_NAME = "iroha-underlay";
const DB_VERSION = 1;
const STORE_NAME = "underlays";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "underlay.id" });
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

/** バージョン不一致・壊れたレコードは無視する(復元に失敗しても起動はする)。 */
function unwrap(raw: unknown): UnderlayRecord | null {
  const envelope = raw as StoredEnvelope | undefined;
  if (envelope === undefined) return null;
  if (envelope.version !== UNDERLAY_SCHEMA_VERSION) return null;
  const underlay = envelope.underlay;
  if (underlay === undefined || underlay === null) return null;
  if (typeof underlay.id !== "string" || typeof underlay.width !== "number") return null;
  return underlay;
}

export class IndexedDbUnderlayStore implements UnderlayStore {
  async put(underlay: UnderlayRecord): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const envelope: StoredEnvelope = { version: UNDERLAY_SCHEMA_VERSION, underlay };
      await promisify(tx.objectStore(STORE_NAME).put(envelope));
    } finally {
      db.close();
    }
  }

  async list(): Promise<UnderlayRecord[]> {
    const db = await openDb();
    let rows: unknown[];
    let keys: IDBValidKey[];
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      // getAll/getAllKeys は同じ順序で対応する(IndexedDB の仕様上、両方ともキー順)。
      [rows, keys] = await Promise.all([promisify(store.getAll()), promisify(store.getAllKeys())]);
    } finally {
      db.close();
    }

    // 読めなくなった(スキーマバージョン不一致・壊れた)行はここで後始末として削除する。
    // 下敷きは取り込み直せるので、読めなくなったものは捨ててよい。作品は子どもの絵なので、
    // 読めないレコードでも消してはいけない(workStore.ts が unwrap で無視するだけに留めているのはそのため)。
    // 削除は一覧取得の本題ではないので、読み取り結果には影響させず、失敗しても無視する。
    const orphanKeys = keys.filter((_, i) => unwrap(rows[i]) === null);
    if (orphanKeys.length > 0) {
      void this.deleteOrphans(orphanKeys);
    }

    return rows
      .map(unwrap)
      .filter((underlay): underlay is UnderlayRecord => underlay !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** list() の後始末。読み取りとは別の readwrite transaction で行い、失敗しても握りつぶす。 */
  private async deleteOrphans(keys: IDBValidKey[]): Promise<void> {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const key of keys) {
          store.delete(key);
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    } catch {
      // 後始末の失敗は無視する。次回の list() でまた掃除を試みる。
    }
  }

  async remove(id: string): Promise<boolean> {
    const db = await openDb();
    try {
      const existing = await this.get(id);
      if (existing === null) return false;
      const tx = db.transaction(STORE_NAME, "readwrite");
      await promisify(tx.objectStore(STORE_NAME).delete(id));
      return true;
    } finally {
      db.close();
    }
  }

  async get(id: string): Promise<UnderlayRecord | null> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      return unwrap(await promisify(tx.objectStore(STORE_NAME).get(id)));
    } finally {
      db.close();
    }
  }
}

/** IndexedDB が使えない環境(プライベートブラウズ等)ではメモリに落とす。 */
export function createUnderlayStore(): UnderlayStore {
  if (typeof indexedDB === "undefined") return new MemoryUnderlayStore();
  return new IndexedDbUnderlayStore();
}

/**
 * 上限を超えたぶんを古い順に本当に消す。消した件数を返す。
 * IndexedDbUnderlayStore / MemoryUnderlayStore どちらでも同じロジックで使えるよう、
 * UnderlayStore インターフェース(list/remove)だけに依存する自由関数にしてある。
 */
export async function pruneUnderlays(store: UnderlayStore, max = MAX_UNDERLAYS): Promise<number> {
  const records = await store.list();
  const evicted = pickEvicted(records, max);
  for (const id of evicted) {
    await store.remove(id);
  }
  return evicted.length;
}
