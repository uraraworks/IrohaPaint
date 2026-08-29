import { defineConfig } from "vite";
import pkg from "./package.json";

// GitHub Pages (https://<user>.github.io/<repo>/) 配下へ置くため生成物のパスを相対にする。
// WebPaint98 / WebNP2 と同じ方針。
export default defineConfig({
  base: "./",
  // ヘッダーに出すバージョンは package.json を唯一の出どころにする(二重管理しない)。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 実機(iPad / Chromebook)からタッチ操作を検証するため dev server を LAN へ公開する。
  server: { host: true },
});
