import { defineConfig } from "vite";

// GitHub Pages (https://<user>.github.io/<repo>/) 配下へ置くため生成物のパスを相対にする。
// WebPaint98 / WebNP2 と同じ方針。
export default defineConfig({
  base: "./",
  // 実機(iPad / Chromebook)からタッチ操作を検証するため dev server を LAN へ公開する。
  server: { host: true },
});
