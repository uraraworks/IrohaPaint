// 作品データモデル。
//
// 企画書§4.5「出口も育つ」／プロト仕様書§7.5「消えない設計」より、
// Phase 0 の UI は 1 枚運用だが *データ構造は最初から* 以下を満たす:
//   - 作品は ID 付きリスト(作品ストア)で持つ    … 将来の作品一覧
//   - 作品は pages[] を持つ                     … 将来の絵本 / マンガ
//   - 削除はフラグ(ソフトデリート)              … 「すてる」→ゴミ箱→「とりもどす」
//   - スナップショットは追記のみ                … 「まえにもどす」/ 上描き事故の復旧
//   - マーク ID を持つ(名前は持たない=個人情報ゼロ)
// ここを後から変えると作り直しになるため、UI が使わないフィールドも今のうちに定義する。

/** 印刷(ポストカード 148x100mm / 300dpi)を見据えた固定キャンバスサイズ。横向き。 */
export const CANVAS_WIDTH = 1748;
export const CANVAS_HEIGHT = 1181;

/** スキーマ変更時に上げる。読み込み時に不一致なら復元しない(壊れたデータで起動しない)。 */
export const SCHEMA_VERSION = 1;

/** ページ 1 枚。画像は PNG の Blob で持つ(Canvas との往復が最も素直)。 */
export interface PageData {
  id: string;
  /** ページの絵。PNG。 */
  image: Blob;
}

/** 作品の状態を丸ごと写したもの。追記のみで、更新も削除もしない。 */
export interface WorkSnapshot {
  id: string;
  /** epoch ミリ秒。 */
  createdAt: number;
  pages: PageData[];
  /** 履歴一覧用の小さい PNG。 */
  thumbnail?: Blob;
  /**
   * なぜ残したか。
   * open   = 誰かが作品をひらいた直後(＝描き始める前の姿)。上書き事故の復旧はこれが要
   * auto   = 描いている途中の定期保存
   * revert = 巻き戻す直前の姿(巻き戻し自体を取り消せるようにする)
   */
  reason: SnapshotReason;
}

export type SnapshotReason = "open" | "auto" | "revert";

export interface WorkRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 「じぶんのマーク」(🐰🦖⚽ 等)の ID。Phase 0 は未使用なので null。 */
  markId: string | null;
  /** ソフトデリート。true でもレコードは残す(「とりもどす」で復活)。 */
  deleted: boolean;
  /** 現在の中身。Phase 0 は常に 1 ページ。 */
  pages: PageData[];
  /**
   * 一覧表示用の小さい PNG。
   * 一覧で原寸(1748x1181)を並べると読み込みだけで数十 MB 動くので、
   * 保存のたびにサムネイルも一緒に作って持っておく。
   * 古い保存データには無いので任意フィールド(無ければ原寸で代用する)。
   */
  thumbnail?: Blob;
  /** 履歴。古い順。追記のみ。 */
  snapshots: WorkSnapshot[];
}

/**
 * 履歴の保持ルール(Time Machine 方式)。
 * 直近は密に、古くなるほど粗く残す。全部残すと 1 作品で数十 MB になり、
 * かといって「直近 N 個」だけだと、翌日に別の子が延々描いた時点で
 * 前日の姿が押し出されてしまう(＝上書き事故の復旧に間に合わない)。
 */
export const KEEP_RECENT = 10;
export const KEEP_DAILY_DAYS = 14;
export const KEEP_WEEKLY_WEEKS = 8;
/** 何があってもこの数は超えない。 */
export const MAX_SNAPSHOTS = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/** その時刻が属する日(ローカル)のキー。 */
function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * 履歴を間引く。残すのは
 *   - 直近 KEEP_RECENT 件(無条件)
 *   - そこから KEEP_DAILY_DAYS 日ぶんは 1 日 1 件(その日の最後の姿)
 *   - さらに古いものは KEEP_WEEKLY_WEEKS 週ぶんを 1 週 1 件
 * 並びは古い順のまま返す。
 */
export function thinSnapshots(
  snapshots: readonly WorkSnapshot[],
  now: number,
): WorkSnapshot[] {
  const sorted = [...snapshots].sort((a, b) => a.createdAt - b.createdAt);
  const keep = new Set<string>();

  for (const snapshot of sorted.slice(-KEEP_RECENT)) keep.add(snapshot.id);

  // 日ごと / 週ごとの代表は「その期間の最後の 1 枚」。後から見て
  // 「その日の終わりの姿」が並ぶ方が、子どもには探しやすい。
  const dailyLimit = now - KEEP_DAILY_DAYS * DAY_MS;
  const weeklyLimit = now - KEEP_WEEKLY_WEEKS * 7 * DAY_MS;
  const daily = new Map<string, string>();
  const weekly = new Map<number, string>();
  for (const snapshot of sorted) {
    if (snapshot.createdAt >= dailyLimit) {
      daily.set(dayKey(snapshot.createdAt), snapshot.id);
    } else if (snapshot.createdAt >= weeklyLimit) {
      weekly.set(Math.floor((now - snapshot.createdAt) / (7 * DAY_MS)), snapshot.id);
    }
  }
  for (const id of daily.values()) keep.add(id);
  for (const id of weekly.values()) keep.add(id);

  const kept = sorted.filter((snapshot) => keep.has(snapshot.id));
  return kept.length > MAX_SNAPSHOTS ? kept.slice(kept.length - MAX_SNAPSHOTS) : kept;
}

let idCounter = 0;

/** 衝突しない ID を作る。crypto.randomUUID が無い環境(古い Safari 等)でも動く。 */
export function createId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`;
}

export function createWork(image: Blob, now: number, thumbnail?: Blob): WorkRecord {
  return {
    id: createId("work"),
    createdAt: now,
    updatedAt: now,
    markId: null,
    deleted: false,
    ...(thumbnail === undefined ? {} : { thumbnail }),
    pages: [{ id: createId("page"), image }],
    snapshots: [],
  };
}

/** 履歴を 1 件追記し、保持ルールに従って間引く。 */
export function appendSnapshot(work: WorkRecord, snapshot: WorkSnapshot): WorkRecord {
  return {
    ...work,
    snapshots: thinSnapshots([...work.snapshots, snapshot], snapshot.createdAt),
    updatedAt: Math.max(work.updatedAt, snapshot.createdAt),
  };
}

/**
 * 現在のページから履歴 1 件分を作る。
 * 画像 Blob は不変なので参照を共有してよい(同じ絵を二重に持たない)。
 */
export function snapshotOf(work: WorkRecord, now: number, reason: SnapshotReason): WorkSnapshot {
  return {
    id: createId("snap"),
    createdAt: now,
    pages: work.pages.map((page) => ({ ...page })),
    ...(work.thumbnail === undefined ? {} : { thumbnail: work.thumbnail }),
    reason,
  };
}
