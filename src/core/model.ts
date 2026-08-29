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
}

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
  /** 履歴。古い順。追記のみ。 */
  snapshots: WorkSnapshot[];
}

/** スナップショットの保持上限。超えたら古い方から間引く(直近は必ず残る)。 */
export const MAX_SNAPSHOTS = 12;

let idCounter = 0;

/** 衝突しない ID を作る。crypto.randomUUID が無い環境(古い Safari 等)でも動く。 */
export function createId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`;
}

export function createWork(image: Blob, now: number): WorkRecord {
  return {
    id: createId("work"),
    createdAt: now,
    updatedAt: now,
    markId: null,
    deleted: false,
    pages: [{ id: createId("page"), image }],
    snapshots: [],
  };
}

/**
 * 履歴を 1 件追記する。上限を超えた分は *古い側から* 落とす。
 * 「まえにもどす」で子どもが選ぶのは基本的に直近なので、新しい側は必ず残す。
 */
export function appendSnapshot(work: WorkRecord, snapshot: WorkSnapshot): WorkRecord {
  const snapshots = [...work.snapshots, snapshot];
  const overflow = snapshots.length - MAX_SNAPSHOTS;
  return {
    ...work,
    snapshots: overflow > 0 ? snapshots.slice(overflow) : snapshots,
    updatedAt: snapshot.createdAt,
  };
}

/** 現在のページから履歴 1 件分を作る。画像 Blob は不変なので参照を共有してよい。 */
export function snapshotOf(work: WorkRecord, now: number): WorkSnapshot {
  return {
    id: createId("snap"),
    createdAt: now,
    pages: work.pages.map((page) => ({ ...page })),
  };
}
