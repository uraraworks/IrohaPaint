// バージョン文字列を作る純粋関数。git 実行(副作用)は compute-version.mjs に分ける。
// 表記は姉妹プロジェクト WebNP2 / WebPaint98 と揃える。
//
// 方針:
// - ビルド時刻(壁時計)は使わない。git commit 時刻だけを情報源にする。
//   同じコミットから何度ビルドしても必ず同じ文字列になることが要件。
// - JST は Intl / toLocaleString を使わず、UTC 基準 + 固定オフセット(+09:00)で求める
//   (ホストのタイムゾーン設定に結果を左右させない)。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * @param {number} commitTsSec commit 時刻(unix 秒・コミッター date)
 * @param {string} shortHash git rev-parse --short=7 HEAD
 * @param {boolean} dirty 作業ツリーが汚れているか
 * @returns {{ label: string, buildId: string }}
 */
export function formatVersion(commitTsSec, shortHash, dirty) {
  const jst = new Date(commitTsSec * 1000 + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const mo = pad2(jst.getUTCMonth() + 1);
  const d = pad2(jst.getUTCDate());
  const h = pad2(jst.getUTCHours());
  const mi = pad2(jst.getUTCMinutes());
  // dirty の印。表示は "+"、URL に載る buildId は "-dirty"
  // ("+" はクエリ内で空白に解釈されうるため)。
  const hashDisplay = dirty ? `${shortHash}+` : shortHash;
  return {
    label: `${y}-${mo}-${d} ${h}:${mi} JST (${hashDisplay})`,
    buildId: dirty ? `${shortHash}-dirty` : shortHash,
  };
}

/** git 情報が取れなかったときの値。もっともらしい値で埋めず「不明」と分かる形にする。 */
export const UNKNOWN_VERSION = {
  label: "version unknown",
  buildId: "unknown",
};
