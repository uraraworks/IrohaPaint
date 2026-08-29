import { defineConfig } from "vite";
import { computeVersion } from "./tools/compute-version.mjs";

// 版はビルド時刻(壁時計)ではなく git commit 時刻とハッシュから作る。
// 同じコミットからは必ず同じ文字列になり、画面の表示から
// 「どのコミットが動いているか」を一意に辿れる(WebNP2 / WebPaint98 と同じ方式)。
const { label } = computeVersion();

// GitHub Pages (https://<user>.github.io/<repo>/) 配下へ置くため生成物のパスを相対にする。
// WebPaint98 / WebNP2 と同じ方針。
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(label),
  },
  // 実機(iPad / Chromebook)からタッチ操作を検証するため dev server を LAN へ公開する。
  server: { host: true },
});
