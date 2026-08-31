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
//
// 2026-08: キャンバスサイズ切り替え・ページ機能に備えたデータ拡張(UI はまだ無い)。
//   - 作品がどの画素数で描かれたかを記録する(canvasWidth/canvasHeight)。
//     記録し忘れると、サイズが選べるようになった瞬間に「過去の作品を引き伸ばすか
//     余白を付けるか」の判断材料が無くなる。しかも利用者の端末に既にあるデータには
//     後から書き込めないので、今のうちから記録を始める。
//   - ページにもソフトデリートを通す(deleted)。作品と同じ「本当には消さない」規則。
import type { LabelPart } from "./tools.ts";
import type { PaperKind } from "./paper.ts";

/** 印刷(ポストカード 148x100mm / 300dpi)を見据えた固定キャンバスサイズ。横向き。 */
export const CANVAS_WIDTH = 1748;
export const CANVAS_HEIGHT = 1181;

/**
 * アイロンビーズ / ドット絵モードのマス数。
 * 1748x1181 を 58x39 で割ると 1 マス ≒ 30px でほぼ正方形になる。
 * 実物のペグボードは 29x29 が基準なので、ちょうど 2x1.35 枚ぶんの図案が置ける。
 */
export const BEAD_COLS = 58;
export const BEAD_ROWS = 39;

/**
 * ドット絵モードのマス数。ビーズのちょうど倍にしてある。
 * 1748x1181 を 116x78 で割ると 1 マス ≒ 15px。ビーズと同じ「マスに置く」操作のまま、
 * 絵として成立する細かさになる下限がこのあたり。これ以上細かくすると、指で 1 マスを
 * 狙えなくなる(拡大が前提になってしまい、子どもの道具ではなくなる)。
 *
 * ゲーム素材のような「16x16 ちょうどの PNG」が要る用途はこの方式では作れない。
 * 大きい紙の上のマスなので、書き出すときに 1748px を 116px へ縮めることになり、
 * 割り切れずにフチが濁るため。そちらはキャンバスサイズ自体を小さくして解く
 * (＝任意サイズのキャンバスを作れるようになってからの話)。
 */
export const DOT_COLS = 116;
export const DOT_ROWS = 78;

/**
 * 「マスに 1 つずつ置く」系のモードが共有する格子。
 *
 * ビーズもドット絵も操作はまったく同じで、違うのは **マスの細かさと 1 マスの絵柄** だけ
 * なので、その 2 つだけを持たせて描画側は 1 本の実装で済ませる。
 */
export interface CellGrid {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** true でアイロンビーズ(穴あきの円)、false でドット絵(四角のベタ塗り)。 */
  round: boolean;
}

function createCellGrid(cols: number, rows: number, round: boolean): CellGrid {
  return {
    cols,
    rows,
    cellWidth: CANVAS_WIDTH / cols,
    cellHeight: CANVAS_HEIGHT / rows,
    round,
  };
}

export const BEAD_GRID: CellGrid = createCellGrid(BEAD_COLS, BEAD_ROWS, true);
export const DOT_GRID: CellGrid = createCellGrid(DOT_COLS, DOT_ROWS, false);

/** スキーマ変更時に上げる。読み込み時に不一致なら復元しない(壊れたデータで起動しない)。 */
export const SCHEMA_VERSION = 1;

/** ページ 1 枚。画像は PNG の Blob で持つ(Canvas との往復が最も素直)。 */
export interface PageData {
  id: string;
  /** ページの絵。PNG。 */
  image: Blob;
  /**
   * ソフトデリート。作品(WorkRecord.deleted)と同じ規則をページにも通す。
   * 「3 ページ目を消したつもりが戻せない」を起きなくするための下ごしらえ。
   * Phase 0 の UI は 1 ページしか作らない/消さないので、常に false のまま使われる
   * (振る舞いは変わらない。フィールドを用意するだけ)。
   */
  deleted: boolean;
}

/**
 * 作品の状態を丸ごと写したもの。追記のみで、更新も削除もしない。
 *
 * canvasWidth/canvasHeight は *持たせない*。背景§1 の通り寸法は「作品ごと」の性質で、
 * 1 冊(1 WorkRecord)の中でページの紙の大きさが途中で変わることは無い前提のため、
 * WorkRecord 側に 1 つ持てば足りる。スナップショットごとに複製すると、
 * 「同じ作品なのにスナップショットによって寸法が違う」という本来あり得ない状態を
 * 型の上で許してしまい、かえって不整合の元になる。
 */
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
  /**
   * この作品が描かれたキャンバスの画素数。
   * ページごとではなく作品ごとに持つ … 1 冊の中でページの紙の大きさが変わることはないため。
   * 古い保存データには無いフィールド。workStore.ts の unwrap() で読むときに、
   * 欠けていたら現在の CANVAS_WIDTH/CANVAS_HEIGHT を補う(＝今ある保存データは
   * 全部この寸法で描かれているので、補って正しい)。
   */
  canvasWidth: number;
  canvasHeight: number;
  /**
   * この作品が描かれた紙の種類(ふつう / わら半紙 / キャンバス)。
   * canvasWidth/canvasHeight と全く同じ理由・作法で作品ごとに持つ(1 冊の中で
   * 紙の種類が途中で変わることは無い前提)。古い保存データには無いフィールドなので、
   * workStore.ts の unwrap() で読むときに欠けていたら "plain" を補う。
   */
  paperKind: PaperKind;
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

export function createWork(
  image: Blob,
  now: number,
  thumbnail?: Blob,
  canvasWidth: number = CANVAS_WIDTH,
  canvasHeight: number = CANVAS_HEIGHT,
  paperKind: PaperKind = "plain",
): WorkRecord {
  return {
    id: createId("work"),
    createdAt: now,
    updatedAt: now,
    markId: null,
    deleted: false,
    canvasWidth,
    canvasHeight,
    paperKind,
    ...(thumbnail === undefined ? {} : { thumbnail }),
    pages: [{ id: createId("page"), image, deleted: false }],
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

// ── 選べるキャンバスサイズの表(未使用) ──────────────────────────────
//
// まだどこからも使わない。将来「新しい作品」でサイズを選べるようにする際に、
// この表から選んで createWork() の canvasWidth/canvasHeight に渡す想定。
// GRID_MODES(src/core/grid.ts)と同じ作り方: id をキーにした Readonly<Record> +
// 表示順を別に持つ配列。

export type CanvasSizeId = "postcard-landscape" | "postcard-portrait" | "manga-b4";

export interface CanvasSizeDef {
  id: CanvasSizeId;
  label: LabelPart[];
  width: number;
  height: number;
}

export const CANVAS_SIZES: Readonly<Record<CanvasSizeId, CanvasSizeDef>> = {
  // 現行の固定サイズ。はがき横(148x100mm)を 300dpi で換算 = 1748x1181。
  "postcard-landscape": {
    id: "postcard-landscape",
    label: [{ base: "はがき", ruby: "はがき" }, { base: "横", ruby: "よこ" }],
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  },
  // はがき縦(100x148mm)を 300dpi で換算 = 1181x1748。横長のちょうど 90 度回転。
  "postcard-portrait": {
    id: "postcard-portrait",
    label: [{ base: "はがき", ruby: "はがき" }, { base: "縦", ruby: "たて" }],
    width: CANVAS_HEIGHT,
    height: CANVAS_WIDTH,
  },
  // マンガ原稿用紙 B4(257x364mm)相当の比率。
  // 実寸(257x364mm)をそのまま 300dpi 換算すると 3035x4299 になり、
  // 他の 2 枠(1748x1181 系)と比べて画素数が 6 倍近くに跳ね上がって扱いづらい
  // (端末のメモリ・保存容量・描画負荷が急に変わる)。
  // そこで「短辺をポストカード枠の 1748 に揃えた近似」を採用する:
  //   長辺 = 1748 × (364 / 257) = 2475.77 → 四捨五入で 2476
  // 実寸の縦横比(364:257 ≒ 1.4163)はそのまま保ち、画素数だけ他の枠と揃える。
  "manga-b4": {
    id: "manga-b4",
    label: [{ base: "マンガ原稿", ruby: "まんがげんこう" }],
    width: 1748,
    height: 2476,
  },
};

export const CANVAS_SIZE_ORDER: readonly CanvasSizeId[] = [
  "postcard-landscape",
  "postcard-portrait",
  "manga-b4",
];
