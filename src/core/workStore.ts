// 作品ストアの永続化。IndexedDB に作品レコードをそのまま入れる。
// Blob は IndexedDB がそのまま格納できる(structured clone)ので、
// PNG を base64 化するような無駄な変換はしない。
import { SCHEMA_VERSION, type WorkRecord } from "./model.ts";

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

const DB_NAME = "sodatsu-paint";
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

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** バージョン不一致・壊れたレコードは無視する(復元に失敗しても起動はする)。 */
function unwrap(raw: unknown): WorkRecord | null {
  const envelope = raw as StoredEnvelope | undefined;
  if (envelope === undefined) return null;
  if (envelope.version !== SCHEMA_VERSION) return null;
  const work = envelope.work;
  if (work === undefined || work === null) return null;
  if (typeof work.id !== "string" || !Array.isArray(work.pages)) return null;
  return work;
}

export class IndexedDbWorkStore implements WorkStore {
  async put(work: WorkRecord): Promise<void> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const envelope: StoredEnvelope = { version: SCHEMA_VERSION, work };
      await promisify(tx.objectStore(STORE_NAME).put(envelope));
    } finally {
      db.close();
    }
  }

  async list(): Promise<WorkRecord[]> {
    return await this.query((work) => !work.deleted);
  }

  async listDeleted(): Promise<WorkRecord[]> {
    return await this.query((work) => work.deleted);
  }

  private async query(keep: (work: WorkRecord) => boolean): Promise<WorkRecord[]> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const rows = await promisify(tx.objectStore(STORE_NAME).getAll());
      return rows
        .map(unwrap)
        .filter((work): work is WorkRecord => work !== null && keep(work))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } finally {
      db.close();
    }
  }

  async setDeleted(id: string, deleted: boolean): Promise<boolean> {
    const work = await this.get(id);
    if (work === null) return false;
    await this.put({ ...work, deleted });
    return true;
  }

  async get(id: string): Promise<WorkRecord | null> {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      return unwrap(await promisify(tx.objectStore(STORE_NAME).get(id)));
    } finally {
      db.close();
    }
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
