// git 情報からバージョン文字列を組み立てる(副作用: git コマンドを実行する)。
// 整形の純粋ロジックは tools/version.mjs 側。
// git が使えない環境でもビルドは失敗させず UNKNOWN_VERSION に落とす。

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { formatVersion, UNKNOWN_VERSION } from "./version.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

function runGit(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** @returns {{ label: string, buildId: string }} */
export function computeVersion() {
  try {
    // --date=format は git のバージョン / ロケールで挙動差があるため使わない。
    // unix 秒(%ct)を取り、JS 側で固定オフセット変換する方が環境非依存。
    const commitTsStr = runGit(["log", "-1", "--format=%ct"]).trim();
    const hash = runGit(["rev-parse", "--short=7", "HEAD"]).trim();
    const status = runGit(["status", "--porcelain"]);
    if (!commitTsStr || !hash) throw new Error("git 出力が空でした");
    const commitTs = Number(commitTsStr);
    if (!Number.isFinite(commitTs)) throw new Error(`commit 時刻の解析に失敗: ${commitTsStr}`);
    return formatVersion(commitTs, hash, status.trim().length > 0);
  } catch (err) {
    console.warn(
      "[compute-version] git 情報を取得できなかったため版文字列を unknown にします:",
      err instanceof Error ? err.message : err,
    );
    return UNKNOWN_VERSION;
  }
}
