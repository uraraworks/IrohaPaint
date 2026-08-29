// 作品カタログ(さくひん一覧)。
//
// ねらい(ユーザー要望):
//   - 1 人で使っていても複数枚とっておきたい
//   - 後日ひらいて描き足したい
//   - 「これだけ描けた」を人に見せたい
//
// 仕様書§7.5「消えない設計」に従い、「すてる」はゴミばこ行き(フラグを立てるだけ)。
// ゴミばこは一覧から覗けて、いつでも「とりもどす」ができる。
import type { WorkRecord, WorkSnapshot } from "../core/model.ts";
import type { LabelPart } from "../core/tools.ts";
import { TOOL_DEFS } from "../core/tools.ts";
import { plainText, renderRuby } from "./label.ts";
import { CLOSE_SVG, HISTORY_SVG, NEW_PAGE_SVG, RESTORE_SVG, TRASH_SVG } from "./icons.ts";

export interface GalleryHandlers {
  onOpen: (id: string) => void;
  onCreate: () => void;
  onTrash: (id: string) => void;
  onRestore: (id: string) => void;
  /** その作品の履歴一覧をひらく。 */
  onHistory: (id: string) => void;
  /** 選んだ履歴の姿に戻す。 */
  onRevert: (workId: string, snapshotId: string) => void;
}

export type GalleryTab = "works" | "trash" | "history";

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

/** タイムラインのカードに出す時刻。日付は区切りに出るのでここでは出さない。 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
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
  history: [{ base: "前", ruby: "まえ" }, { base: "に" }, { base: "戻", ruby: "もど" }, { base: "す" }],
  historyTitle: [
    { base: "前", ruby: "まえ" },
    { base: "の" },
    { base: "絵", ruby: "え" },
  ],
  revert: [{ base: "これに" }, { base: "戻", ruby: "もど" }, { base: "す" }],
  opened: [{ base: "ひらいた とき" }],
  reverted: [{ base: "戻", ruby: "もど" }, { base: "す まえ" }],
  noHistory: [{ base: "まだ ありません" }],
  nowMark: [{ base: "今", ruby: "いま" }],
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
    this.grid.className = "gallery-grid";
    this.setTitle(
      this.tab === "works" ? TEXT.works : TEXT.trash,
      this.tab === "works" ? (TOOL_DEFS.works.iconSvg ?? "") : TRASH_SVG,
    );
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

  /**
   * 1 つの作品の履歴を **横に流れるタイムライン** で並べる。
   * 日付と時刻を数字で読ませると、どれが「さっきの姿」か子どもには判断しづらい。
   * 左が古く右が新しい 1 本の帯にして、右端(＝今)から左へスライドすると
   * 過去へ遡る、という位置関係そのもので時間を見せる。
   */
  renderHistory(work: WorkRecord, now: number): void {
    this.tab = "history";
    this.releaseUrls();
    this.grid.textContent = "";
    this.grid.className = "gallery-grid is-timeline";
    this.setTitle(TEXT.historyTitle, HISTORY_SVG);
    this.setTabButton();

    if (work.snapshots.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gallery-empty";
      empty.appendChild(renderRuby(TEXT.noHistory));
      this.grid.appendChild(empty);
      return;
    }

    const track = document.createElement("div");
    track.className = "timeline-track";

    // 古い順(左→右)。時間の流れと並びを一致させる。
    const snapshots = [...work.snapshots].sort((a, b) => a.createdAt - b.createdAt);
    let lastDay = "";
    for (const snapshot of snapshots) {
      const day = new Date(snapshot.createdAt).toDateString();
      if (day !== lastDay) {
        track.appendChild(this.createDayMark(snapshot.createdAt, now));
        lastDay = day;
      }
      track.appendChild(this.createHistoryCard(work.id, snapshot, now));
    }
    // 右端は「今の絵」。ここが現在地だと分かると、左へ行くほど過去だと伝わる。
    track.appendChild(this.createNowMark());

    this.grid.appendChild(track);
    // 現在地(右端)から始める。過去を見たい子だけが左へスライドすればよい。
    this.grid.scrollLeft = this.grid.scrollWidth;
  }

  /** 日付の区切り。同じ日の中は時刻だけを見ればよくなる。 */
  private createDayMark(timestamp: number, now: number): HTMLElement {
    const mark = document.createElement("div");
    mark.className = "timeline-daymark";
    const label = document.createElement("span");
    label.className = "timeline-daylabel";
    label.appendChild(renderRuby(formatDate(timestamp, now)));
    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    mark.append(label, dot);
    return mark;
  }

  private createNowMark(): HTMLElement {
    const mark = document.createElement("div");
    mark.className = "timeline-daymark timeline-now";
    const label = document.createElement("span");
    label.className = "timeline-daylabel";
    label.appendChild(renderRuby(TEXT.nowMark));
    const dot = document.createElement("span");
    dot.className = "timeline-dot";
    mark.append(label, dot);
    return mark;
  }

  private createHistoryCard(workId: string, snapshot: WorkSnapshot, now: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "gallery-card timeline-card";

    const thumb = document.createElement("div");
    thumb.className = "gallery-thumb";
    const image = snapshot.thumbnail ?? snapshot.pages[0]?.image;
    if (image !== undefined) {
      const url = URL.createObjectURL(image);
      this.urls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      thumb.appendChild(img);
    }

    const caption = document.createElement("div");
    caption.className = "gallery-caption";
    // 日付は区切りに出るので、カードには時刻だけ。
    caption.textContent = formatTime(snapshot.createdAt);

    // どういう場面の姿かを一言添える。「ひらいた とき」が上書き事故の戻し先になる。
    const note = document.createElement("div");
    note.className = "gallery-note";
    if (snapshot.reason === "open") note.appendChild(renderRuby(TEXT.opened));
    else if (snapshot.reason === "revert") note.appendChild(renderRuby(TEXT.reverted));

    const action = createLabeledButton("gallery-action", RESTORE_SVG, TEXT.revert);
    action.addEventListener("click", () => this.handlers.onRevert(workId, snapshot.id));

    const dot = document.createElement("span");
    dot.className = "timeline-dot";

    card.append(thumb, caption, note, action, dot);
    return card;
  }

  /** 見出しは「アイコン + 文字」。どの画面にいるかを絵でも分かるようにする。 */
  private setTitle(parts: LabelPart[], iconSvg: string): void {
    this.title.textContent = "";
    const icon = document.createElement("span");
    icon.className = "gallery-title-icon";
    icon.innerHTML = iconSvg;
    const text = document.createElement("span");
    text.appendChild(renderRuby(parts));
    this.title.append(icon, text);
  }

  private setTabButton(): void {
    const isWorks = this.tab === "works";
    const icon = this.tabButton.querySelector(".btn-icon");
    const label = this.tabButton.querySelector(".btn-label");
    if (icon !== null) icon.innerHTML = isWorks ? TRASH_SVG : (TOOL_DEFS.works.iconSvg ?? "");
    const parts = isWorks ? TEXT.trash : TEXT.backToWorks;
    // 履歴からもゴミ箱からも、同じボタンで作品一覧へ帰れる(迷子にしない)。
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

    if (this.tab === "works") {
      // 履歴は作品ごとにひらく。「誰かに上から描かれた」に気づいた子が
      // その作品の中だけを見て戻せるようにする。
      const history = createLabeledButton("gallery-action gallery-history", HISTORY_SVG, TEXT.history);
      history.addEventListener("click", () => this.handlers.onHistory(work.id));
      card.append(open, caption, history, action);
      return card;
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
