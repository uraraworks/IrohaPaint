// 全画面表示。
//
// WebNP2 で得た知見をそのまま踏襲する:
//   - 対象は **ページ全体(documentElement)**。特定の要素を全画面にすると、
//     その部分木の外にあるツールバーやパネルが一切描画されない
//   - iPhone の WebKit は <video> 以外の全画面に対応せず、メソッド自体が生えていない
//     (iPad は webkit 版を持つ)。iOS 版 Chrome も中身は WebKit なので同じ。
//     呼んでも例外すら出ずに何も起きないので、事前に判定してボタンごと隠す
//   - Safari は接頭辞付き(webkit*)しか無い版があるため両方を見る

interface WebkitElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}

interface WebkitDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

/** この環境で全画面にできるか。できないならボタンを出さない。 */
export function isFullscreenSupported(): boolean {
  const root = document.documentElement as WebkitElement;
  const doc = document as WebkitDocument;
  const hasMethod =
    typeof root.requestFullscreen === "function" || typeof root.webkitRequestFullscreen === "function";
  const enabled = document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  return hasMethod && enabled;
}

export function isFullscreenActive(): boolean {
  const doc = document as WebkitDocument;
  return Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** 全画面の入り / 出をひっくり返す。失敗しても描画には影響しないので握りつぶす。 */
export async function toggleFullscreen(): Promise<void> {
  const root = document.documentElement as WebkitElement;
  const doc = document as WebkitDocument;
  try {
    if (isFullscreenActive()) {
      if (typeof document.exitFullscreen === "function") await document.exitFullscreen();
      else doc.webkitExitFullscreen?.();
      return;
    }
    if (typeof root.requestFullscreen === "function") await root.requestFullscreen();
    else root.webkitRequestFullscreen?.();
  } catch {
    // ユーザー操作から外れた等で断られることがある。描くことには影響しない。
  }
}

/** 全画面状態が変わったときに呼ばれる。戻り値は購読解除関数。 */
export function onFullscreenChange(listener: () => void): () => void {
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);
  return () => {
    document.removeEventListener("fullscreenchange", listener);
    document.removeEventListener("webkitfullscreenchange", listener);
  };
}
