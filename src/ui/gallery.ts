// 作品カタログ(さくひん一覧)。
//
// ねらい(ユーザー要望):
//   - 1 人で使っていても複数枚とっておきたい
//   - 後日ひらいて描き足したい
//   - 「これだけ描けた」を人に見せたい
//
// 仕様書§7.5「消えない設計」に従い、「すてる」はゴミばこ行き(フラグを立てるだけ)。
// ゴミばこは一覧から覗けて、いつでも「とりもどす」ができる。
import type { WorkRecord } from "../core/model.ts";

export interface GalleryHandlers {
  onOpen: (id: string) => void;
  onCreate: () => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
}

export type GalleryTab = "works" | "trash";

/** 日付は子どもが読める形に。年は同じ年なら出さない。 */
export function formatDate(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const md = `${date.getMonth() + 1}がつ${date.getDate()}にち`;
  return date.getFullYear() === today.getFullYear() ? md : `${date.getFullYear()}ねん${md}`;
}

export class Gallery {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly tabButton: HTMLButtonElement;
  private readonly title: HTMLElement;
  private tab: GalleryTab = "works";
  /** 生成した Object URL。閉じるときにまとめて解放する(枚数が増えるとリークが効いてくる)。 */
  private urls: string[] = [];

  constructor(parent: HTMLElement, private readonly handlers: GalleryHandlers) {
    this.element = document.createElement("div");
    this.element.className = "gallery";

    const header = document.createElement("div");
    header.className = "gallery-header";

    this.title = document.createElement("h1");
    this.title.className = "gallery-title";

    this.tabButton = document.createElement("button");
    this.tabButton.className = "gallery-tab";

    const close = document.createElement("button");
    close.className = "gallery-close";
    close.textContent = "とじる";
    close.addEventListener("click", () => this.close());

    header.append(this.title, this.tabButton, close);

    this.grid = document.createElement("div");
    this.grid.className = "gallery-grid";

    this.element.append(header, this.grid);
    parent.appendChild(this.element);
  }

  get isOpen(): boolean {
    return this.element.classList.contains("is-open");
  }

  /** works=保存済み / trash=ゴミばこ。currentId は「いま描いている絵」の目印。 */
  render(works: readonly WorkRecord[], currentId: string | null, now: number): void {
    this.releaseUrls();
    this.grid.textContent = "";
    this.title.textContent = this.tab === "works" ? "さくひん" : "ゴミばこ";
    this.tabButton.textContent = this.tab === "works" ? "ゴミばこ" : "さくひんに もどる";

    if (this.tab === "works") this.grid.appendChild(this.createNewCard());

    for (const work of works) {
      this.grid.appendChild(this.createCard(work, currentId, now));
    }

    if (this.tab === "trash" && works.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.textContent = "ゴミばこは からっぽ";
      this.grid.appendChild(empty);
    }
  }

  private createNewCard(): HTMLElement {
    const card = document.createElement("button");
    card.className = "gallery-card gallery-new";
    card.innerHTML = `<span class="gallery-plus">＋</span><span class="gallery-caption">あたらしく かく</span>`;
    card.addEventListener("click", () => this.handlers.onCreate());
    return card;
  }

  private createCard(work: WorkRecord, currentId: string | null, now: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "gallery-card";
    if (work.id === currentId) card.classList.add("is-current");

    const open = document.createElement("button");
    open.className = "gallery-thumb";
    const image = work.thumbnail ?? work.pages[0]?.image;
    if (image !== undefined) {
      const url = URL.createObjectURL(image);
      this.urls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      open.appendChild(img);
    }
    // ゴミばこの中の絵は開けない。まず「とりもどす」を通す(取り違えを起こさせない)。
    if (this.tab === "works") open.addEventListener("click", () => this.handlers.onOpen(work.id));
    else open.disabled = true;

    const caption = document.createElement("div");
    caption.className = "gallery-caption";
    caption.textContent = work.id === currentId ? "いま かいてる" : formatDate(work.updatedAt, now);

    const action = document.createElement("button");
    action.className = "gallery-action";
    if (this.tab === "works") {
      action.textContent = "すてる";
      action.addEventListener("click", () => this.handlers.onTrash(work.id));
    } else {
      action.textContent = "とりもどす";
      action.addEventListener("click", () => this.handlers.onRestore(work.id));
    }

    card.append(open, caption, action);
    return card;
  }

  /** ゴミばこ表示との行き来。切り替え後の再描画は呼び出し側に任せる。 */
  onTabChange(listener: (tab: GalleryTab) => void): void {
    this.tabButton.addEventListener("click", () => {
      this.tab = this.tab === "works" ? "trash" : "works";
      listener(this.tab);
    });
  }

  get currentTab(): GalleryTab {
    return this.tab;
  }

  open(): void {
    this.element.classList.add("is-open");
  }

  close(): void {
    this.element.classList.remove("is-open");
    this.tab = "works";
    this.releaseUrls();
  }

  private releaseUrls(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }
}
