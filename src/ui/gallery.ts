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
import type { LabelPart } from "../core/tools.ts";
import { TOOL_DEFS } from "../core/tools.ts";
import { plainText, renderRuby } from "./label.ts";
import { CLOSE_SVG, NEW_PAGE_SVG, RESTORE_SVG, TRASH_SVG } from "./icons.ts";

export interface GalleryHandlers {
  onOpen: (id: string) => void;
  onCreate: () => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
}

export type GalleryTab = "works" | "trash";

/**
 * 日付も他の文言と同じく漢字＋総ルビ(L2)で出す。年は同じ年なら出さない。
 * 文字列ではなく LabelPart[] を返すのは、L3(ふりがなオフ)へ切り替えるときに
 * 日付だけ取り残されないようにするため。
 */
export function formatDate(timestamp: number, now: number): LabelPart[] {
  const date = new Date(timestamp);
  const today = new Date(now);
  const monthDay: LabelPart[] = [
    { base: String(date.getMonth() + 1) },
    { base: "月", ruby: "がつ" },
    { base: String(date.getDate()) },
    { base: "日", ruby: "にち" },
  ];
  if (date.getFullYear() === today.getFullYear()) return monthDay;
  return [{ base: String(date.getFullYear()) }, { base: "年", ruby: "ねん" }, ...monthDay];
}

/** UI 文言。すべて漢字＋総ルビで持つ。 */
const TEXT = {
  works: [{ base: "作品", ruby: "さくひん" }],
  trash: [{ base: "ゴミ" }, { base: "箱", ruby: "ばこ" }],
  backToWorks: [{ base: "作品", ruby: "さくひん" }, { base: "に" }, { base: "戻", ruby: "もど" }, { base: "る" }],
  close: [{ base: "閉", ruby: "と" }, { base: "じる" }],
  create: [{ base: "新", ruby: "あたら" }, { base: "しく" }, { base: "描", ruby: "か" }, { base: "く" }],
  // ツールバーの「描く」と字を揃える(同じ行為に別の字を当てない)。
  now: [{ base: "今", ruby: "いま" }, { base: "描", ruby: "か" }, { base: "いてる" }],
  trashIt: [{ base: "捨", ruby: "す" }, { base: "てる" }],
  restore: [{ base: "取", ruby: "と" }, { base: "り" }, { base: "戻", ruby: "もど" }, { base: "す" }],
  empty: [{ base: "ゴミ" }, { base: "箱", ruby: "ばこ" }, { base: "は からっぽ" }],
} satisfies Record<string, LabelPart[]>;

/** アイコン + 文言(ルビ付き)のボタンを作る。ボタンの形はどこも同じにする。 */
function createLabeledButton(className: string, iconSvg: string, parts: LabelPart[]): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = className;
  const icon = document.createElement("span");
  icon.className = "btn-icon";
  icon.innerHTML = iconSvg;
  const label = document.createElement("span");
  label.className = "btn-label";
  label.appendChild(renderRuby(parts));
  button.append(icon, label);
  // ルビが二重に読まれないよう、読み上げにはふりがな抜きの文字列を渡す。
  button.setAttribute("aria-label", plainText(parts));
  return button;
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

    this.tabButton = createLabeledButton("gallery-tab", TRASH_SVG, TEXT.trash);

    const close = createLabeledButton("gallery-close", CLOSE_SVG, TEXT.close);
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
    this.title.textContent = "";
    this.title.appendChild(renderRuby(this.tab === "works" ? TEXT.works : TEXT.trash));
    this.setTabButton();

    if (this.tab === "works") this.grid.appendChild(this.createNewCard());

    for (const work of works) {
      this.grid.appendChild(this.createCard(work, currentId, now));
    }

    if (this.tab === "trash" && works.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.appendChild(renderRuby(TEXT.empty));
      this.grid.appendChild(empty);
    }
  }

  private setTabButton(): void {
    const isWorks = this.tab === "works";
    const icon = this.tabButton.querySelector(".btn-icon");
    const label = this.tabButton.querySelector(".btn-label");
    if (icon !== null) icon.innerHTML = isWorks ? TRASH_SVG : (TOOL_DEFS.works.iconSvg ?? "");
    const parts = isWorks ? TEXT.trash : TEXT.backToWorks;
    if (label !== null) {
      label.textContent = "";
      label.appendChild(renderRuby(parts));
    }
    this.tabButton.setAttribute("aria-label", plainText(parts));
  }

  private createNewCard(): HTMLElement {
    const card = createLabeledButton("gallery-card gallery-new", NEW_PAGE_SVG, TEXT.create);
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
    caption.appendChild(renderRuby(work.id === currentId ? TEXT.now : formatDate(work.updatedAt, now)));

    const action =
      this.tab === "works"
        ? createLabeledButton("gallery-action", TRASH_SVG, TEXT.trashIt)
        : createLabeledButton("gallery-action", RESTORE_SVG, TEXT.restore);
    action.addEventListener("click", () =>
      this.tab === "works" ? this.handlers.onTrash(work.id) : this.handlers.onRestore(work.id),
    );

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
