// そだつペイント（仮）Phase 0 プロト。
// 受け入れ条件(プロト仕様書§8):
//   1. 開いた瞬間、説明なしで線が描ける
//   2. アイコンを押すとパネルが「ぽよん」と開く
//   3. 描いていると宝箱が現れ、吹き出し 1 個の誘導で道具が増える
//   4. 「かんせい！」で PNG が保存でき、祝福演出が出る
//   5. リロードしても絵が残っている
//   6. iPad(指)と PC(マウス)の両方で成立する
import "./style.css";
import { BEAD_COLORS, CRAYON_COLORS, ERASER_SIZES, nearestBeadColor, PEN_SIZES } from "./core/palette.ts";
import { NIB_DEFS, NIB_ORDER, type NibId } from "./core/brush.ts";
import { GRID_MODES, GRID_MODE_ORDER, type GridMode } from "./core/grid.ts";
import {
  appendSnapshot,
  createWork,
  snapshotOf,
  type SnapshotReason,
  type WorkRecord,
} from "./core/model.ts";
import { createWorkStore, requestPersistentStorage } from "./core/workStore.ts";
import { hexToRgba, Surface } from "./core/surface.ts";
import { installPointerInput, type PointerInputControl } from "./core/pointerInput.ts";
import { clampView, IDENTITY, panBy, toCss, zoomAt, type ViewTransform } from "./core/viewport.ts";
import { CHEST_ICON_SVG, INITIAL_TOOLS, nextUnlock, TOOL_DEFS, type ToolId, type Unlock } from "./core/tools.ts";
import { labelText, plainText, renderLabel, renderRuby } from "./ui/label.ts";
import { SoundPlayer } from "./core/sound.ts";
import { loadProgress, saveProgress } from "./core/progress.ts";
import { GuideBubble } from "./ui/guide.ts";
import { celebrate } from "./ui/celebrate.ts";
import { Panel } from "./ui/panel.ts";
import { Gallery } from "./ui/gallery.ts";
import { FIT_SVG, SOUND_OFF_SVG, SOUND_ON_SVG } from "./ui/icons.ts";

/** 描き終わってから保存するまでの待ち時間。描画中に保存すると重い。 */
const AUTOSAVE_DELAY_MS = 800;
/** 履歴(まえにもどす)を積む間隔。 */
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;

type ActiveTool = "pen" | "eraser" | "picker" | "fill";

class App {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly paperWrap: HTMLElement;
  private readonly gridLayer: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly surface: Surface;
  private readonly sound = new SoundPlayer();
  private readonly guide: GuideBubble;
  private readonly store = createWorkStore();
  private readonly buttons = new Map<string, HTMLElement>();

  /** 道具箱の中身。一度増えたら減らない(進捗は localStorage に永続化)。 */
  private ownedTools: ToolId[] = [...INITIAL_TOOLS];
  private activeTool: ActiveTool = "pen";
  private color = CRAYON_COLORS[0] ?? "#3d3730";
  private penSize = PEN_SIZES[1] ?? 26;
  private eraserSize = ERASER_SIZES[1] ?? 70;
  /** 下敷き。なし / 方眼 / ビーズ。ビーズはマスにしか置けなくなる。 */
  private gridMode: GridMode = "off";
  private nib: NibId = "crayon";
  private strokeCount = 0;
  private pendingUnlock: Unlock | null = null;

  private work: WorkRecord | null = null;
  /** 起動時に復元する作品 ID(復元後は this.work が正)。 */
  private currentWorkId: string | null = null;
  private saveTimer: number | null = null;
  private lastSnapshotAt = 0;
  /** 指ごとの、直前に受け取った生の座標(手ブレ補正前)。離した位置まで線を伸ばすのに使う。 */
  private readonly lastPoints = new Map<number, { x: number; y: number }>();
  /** 「みんなで描く」モード。同時に何本も描ける代わりに、拡大と戻るを止める。 */
  private multiDraw = false;

  private input: PointerInputControl | null = null;
  private fitButton: HTMLElement | null = null;
  /** 紙の見え方(ピンチ拡大・移動)。描画内容には影響しない。 */
  private view: ViewTransform = IDENTITY;

  private colorPanel!: Panel;
  private penPanel!: Panel;
  private eraserPanel!: Panel;
  private gridPanel!: Panel;
  private gallery!: Gallery;

  constructor(root: HTMLElement) {
    this.root = root;
    // 前回までに増えた道具と描いた量を先に戻す。ここを忘れると
    // リロードで道具箱だけ巻き戻り、宝箱がもう一度出てしまう。
    const progress = loadProgress();
    this.ownedTools = progress.ownedTools;
    this.strokeCount = progress.strokeCount;
    this.currentWorkId = progress.currentWorkId;
    this.gridMode = progress.gridMode;
    this.nib = progress.nib;
    this.multiDraw = progress.multiDraw;

    this.stage = document.createElement("div");
    this.stage.className = "stage";
    const canvas = document.createElement("canvas");
    canvas.className = "paper";
    // 方眼は「下敷き」なので絵とは別のレイヤーに置く。
    // こうすると PNG 書き出し(キャンバスのみ)に線が入らない。
    this.paperWrap = document.createElement("div");
    this.paperWrap.className = "paper-wrap";
    this.gridLayer = document.createElement("div");
    this.gridLayer.className = "grid-layer";
    this.paperWrap.append(canvas, this.gridLayer);
    this.stage.appendChild(this.paperWrap);

    this.toolbar = document.createElement("div");
    this.toolbar.className = "toolbar";

    root.append(this.stage, this.toolbar);
    this.surface = new Surface(canvas);
    // 描いている最中の末尾を映す層(surface.ts の overlay)。方眼より下に敷く。
    this.paperWrap.insertBefore(this.surface.overlay, this.gridLayer);
    this.guide = new GuideBubble(document.body);

    this.buildPanels();
    this.buildGallery();
    this.renderToolbar();
    this.buildSoundToggle();
    this.buildFitButton();
    this.installInput(canvas);
    this.input?.setMultiDraw(this.multiDraw);
    this.installWheelZoom(canvas);
    // PC のキーボードも一応拾う(タッチが主・マウス/キーは後追いという位置づけ)。
    window.addEventListener("keydown", (event) => {
      if (this.multiDraw) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        // Shift+Ctrl+Z は「進む」。PC の一般的な作法に合わせる。
        const moved = event.shiftKey ? this.surface.redo() : this.surface.undo();
        if (moved) this.afterHistoryChange();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        if (this.surface.redo()) this.afterHistoryChange();
      }
    });
    void this.restore();
    // 作品が勝手に消えないよう永続化を頼んでおく(結果は待たない)。
    void requestPersistentStorage();
  }

  // --- 組み立て ---------------------------------------------------------

  private buildPanels(): void {
    this.colorPanel = new Panel(document.body, "color-panel");
    // 2 組のパレットを持ち、下敷きに応じて出し分ける。
    // ビーズは実物に無い色で描くと再現できないので、専用の色だけを見せる。
    this.colorPanel.element.append(
      this.createSwatches(CRAYON_COLORS, "swatches crayon-swatches"),
      this.createSwatches(BEAD_COLORS, "swatches bead-swatches"),
    );

    this.penPanel = this.createSizePanel("pen-panel", PEN_SIZES, (size) => {
      this.penSize = size;
      this.setActiveTool("pen");
      this.sound.play("poko");
    });
    // 太さの上に「ペン先」の段を足す。
    // クレヨン(太さ一定)が既定で、Ｇペン・筆は速さで太さが変わる = お手本を見せる用。
    this.penPanel.element.prepend(this.createNibRow());
    this.eraserPanel = this.createSizePanel("eraser-panel", ERASER_SIZES, (size) => {
      this.eraserSize = size;
      this.setActiveTool("eraser");
      this.sound.play("shu");
    });
    this.gridPanel = this.createGridPanel();
    this.syncSwatches();
    this.syncSizes();
    this.syncNibs();
    this.syncGridButtons();

    // パネル外タップで閉じる。
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (this.isToolbarNode(target)) return;
      for (const panel of [this.colorPanel, this.penPanel, this.eraserPanel, this.gridPanel]) {
        if (panel.isOpen && !panel.element.contains(target)) panel.close();
      }
    });
  }

  private createSwatches(colors: readonly string[], className: string): HTMLElement {
    const swatches = document.createElement("div");
    swatches.className = className;
    for (const color of colors) {
      const swatch = document.createElement("button");
      swatch.className = "swatch";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", `いろ ${color}`);
      swatch.addEventListener("click", () => {
        this.color = color;
        // 色を選んだら描ける状態に戻す(消しゴムのまま色を選ぶ事故を防ぐ)。
        if (this.activeTool === "eraser") this.setActiveTool("pen");
        this.syncSwatches();
        this.syncColorChip();
        this.sound.play("poko");
        this.colorPanel.close();
      });
      swatches.appendChild(swatch);
    }
    return swatches;
  }

  /** 下敷きを選ぶパネル(なし / 方眼 / ビーズ)。将来のドット絵モードもここへ足す。 */
  private createGridPanel(): Panel {
    const panel = new Panel(document.body, "grid-panel");
    for (const id of GRID_MODE_ORDER) {
      const def = GRID_MODES[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.grid = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", plainText(def.label));
      button.addEventListener("click", () => {
        this.setGridMode(id);
        this.sound.play(id === "off" ? "shu" : "poko");
        panel.close();
      });
      panel.element.appendChild(button);
    }
    return panel;
  }

  private createNibRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "nib-row";
    for (const id of NIB_ORDER) {
      const def = NIB_DEFS[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.nib = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", plainText(def.label));
      button.addEventListener("click", () => {
        this.nib = id;
        this.setActiveTool("pen");
        this.syncNibs();
        this.persistProgress();
        this.sound.play("poko");
      });
      row.appendChild(button);
    }
    return row;
  }

  private syncNibs(): void {
    for (const element of this.penPanel.element.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.nib === this.nib);
    }
  }

  /** 太さを選ぶパネル。ふでと消しゴムで同じ形にする(操作を覚え直させない)。 */
  private createSizePanel(
    className: string,
    sizes: readonly number[],
    onPick: (size: number) => void,
  ): Panel {
    const panel = new Panel(document.body, className);
    // 太さは 1 行に並べる(ペン先の段と積み重ねるため、行を箱に入れておく)。
    const row = document.createElement("div");
    row.className = "size-row";
    for (const size of sizes) {
      const button = document.createElement("button");
      button.className = "size-button";
      button.dataset.size = String(size);
      const dot = document.createElement("span");
      dot.className = "size-dot";
      // キャンバス実解像度の太さをそのまま出すと大きすぎるので縮めて見せる。
      const shown = Math.min(64, Math.max(8, Math.round(size * 0.6)));
      dot.style.width = `${shown}px`;
      dot.style.height = `${shown}px`;
      button.appendChild(dot);
      button.setAttribute("aria-label", `ふとさ ${size}`);
      button.addEventListener("click", () => {
        onPick(size);
        this.syncSizes();
        panel.close();
      });
      row.appendChild(button);
    }
    panel.element.appendChild(row);
    return panel;
  }

  private isToolbarNode(node: Node): boolean {
    return this.toolbar.contains(node);
  }

  private buildGallery(): void {
    this.gallery = new Gallery(document.body, {
      onOpen: (id) => void this.openWork(id),
      onCreate: () => void this.createWork(),
      onTrash: (id) => void this.trashWork(id),
      onRestore: (id) => void this.restoreWork(id),
      onHistory: (id) => void this.showHistory(id),
      onRevert: (workId, snapshotId) => void this.revertTo(workId, snapshotId),
    });
    this.gallery.onTabChange(() => void this.refreshGallery());
  }

  /** 拡大しているときだけ現れる「ぜんぶ見る」。押すと等倍に戻る。 */
  private buildFitButton(): void {
    const button = document.createElement("button");
    button.className = "fit-button";
    button.innerHTML = `${FIT_SVG}<span>ぜんぶ</span>`;
    button.setAttribute("aria-label", "ぜんぶ見る");
    button.addEventListener("click", () => {
      this.applyView(IDENTITY);
      this.sound.play("shu");
    });
    this.stage.appendChild(button);
    this.fitButton = button;
  }

  private buildSoundToggle(): void {
    const button = document.createElement("button");
    button.className = "sound-toggle";
    button.innerHTML = SOUND_ON_SVG;
    button.setAttribute("aria-label", "おとの おんおふ");
    button.addEventListener("click", () => {
      this.sound.setEnabled(!this.sound.isEnabled);
      button.innerHTML = this.sound.isEnabled ? SOUND_ON_SVG : SOUND_OFF_SVG;
      // 切った直後は鳴らない。切り替わったことは見た目で分かる。
      this.sound.play("poko");
    });
    this.stage.appendChild(button);
  }

  private renderToolbar(): void {
    this.toolbar.textContent = "";
    this.buttons.clear();
    for (const id of this.ownedTools) {
      if (id === "done") continue; // 「かんせい！」は最後に置く
      this.toolbar.appendChild(this.createToolButton(id));
    }
    if (this.pendingUnlock !== null) this.toolbar.appendChild(this.createChestButton(this.pendingUnlock));
    this.toolbar.appendChild(this.createToolButton("done"));
    this.syncActive();
    this.syncHistoryButtons();
    this.syncGridButtons();
    this.syncMultiDraw();
  }

  private createToolButton(id: ToolId): HTMLElement {
    const def = TOOL_DEFS[id];
    const button = document.createElement("button");
    button.className = id === "done" ? "tool-button done" : "tool-button";
    button.dataset.tool = id;
    const icon = document.createElement("span");
    icon.className = "icon";
    if (id === "color") {
      // 今えらんでいる色をボタン自体に出す。パネルを開かなくても何色か分かる。
      const chip = document.createElement("span");
      chip.className = "color-chip";
      chip.style.background = this.color;
      icon.appendChild(chip);
    } else if (def.iconSvg !== undefined) {
      icon.innerHTML = def.iconSvg;
    } else {
      icon.textContent = def.icon;
    }
    const label = document.createElement("span");
    label.className = "label";
    label.appendChild(renderLabel(def));
    button.append(icon, label);
    // 読み上げにはふりがな抜きの素の文字列を渡す(ルビが二重に読まれるのを避ける)。
    button.setAttribute("aria-label", labelText(def));
    // click(押して離す)で発火させる。描画中に指が滑り込んでも誤爆しない。
    button.addEventListener("click", () => this.onToolButton(id, button));
    this.buttons.set(id, button);
    return button;
  }

  private createChestButton(unlock: Unlock): HTMLElement {
    const button = document.createElement("button");
    button.className = "tool-button chest is-new";
    const chestIcon = document.createElement("span");
    chestIcon.className = "icon";
    chestIcon.innerHTML = CHEST_ICON_SVG;
    const chestLabel = document.createElement("span");
    chestLabel.className = "label";
    // 宝箱だけは「開けたくなる」ことが全てなので、読みやすさ優先でひらがなのまま。
    chestLabel.textContent = "あける";
    button.append(chestIcon, chestLabel);
    button.setAttribute("aria-label", "たからばこを あける");
    button.addEventListener("click", () => this.openChest(unlock));
    this.buttons.set("chest", button);
    return button;
  }

  // --- 操作 -------------------------------------------------------------

  private onToolButton(id: ToolId, button: HTMLElement): void {
    this.sound.unlock();
    this.guide.hide();
    // これから開くもの以外は閉じる。開きっぱなしだとパネル同士が重なり、
    // 下のパネルのボタンを押せてしまう。
    const keep =
      id === "color"
        ? this.colorPanel
        : id === "pen"
          ? this.penPanel
          : id === "eraser"
            ? this.eraserPanel
            : id === "grid"
              ? this.gridPanel
              : null;
    for (const panel of [this.colorPanel, this.penPanel, this.eraserPanel, this.gridPanel]) {
      if (panel !== keep) panel.close();
    }
    switch (id) {
      case "pen":
        this.setActiveTool("pen");
        // ビーズモードには太さもペン先も無いのでパネルを出さない。
        // ビーズは 1 マス = 1 ビーズなので太さもペン先も無い(パネルを出さない)。
        if (!this.snapToCells) this.penPanel.toggle(button);
        this.sound.play("poko");
        break;
      case "color":
        this.colorPanel.toggle(button);
        this.sound.play("poko");
        break;
      case "eraser":
        this.setActiveTool("eraser");
        if (!this.snapToCells) this.eraserPanel.toggle(button);
        this.sound.play("shu");
        break;
      case "picker":
        this.setActiveTool("picker");
        this.sound.play("poko");
        break;
      case "fill":
        this.setActiveTool("fill");
        this.sound.play("poko");
        break;
      case "undo":
        if (this.multiDraw) break;
        if (this.surface.undo()) {
          this.sound.play("shu");
          this.afterHistoryChange();
        }
        break;
      case "redo":
        if (this.multiDraw) break;
        if (this.surface.redo()) {
          this.sound.play("poko");
          this.afterHistoryChange();
        }
        break;
      case "together":
        this.setMultiDraw(!this.multiDraw);
        this.sound.play(this.multiDraw ? "fanfare" : "poko");
        break;
      case "grid":
        this.gridPanel.toggle(button);
        this.sound.play("poko");
        break;
      case "works":
        void this.openGallery();
        break;
      case "done":
        void this.exportPng();
        break;
    }
  }

  private setActiveTool(tool: ActiveTool): void {
    this.activeTool = tool;
    this.syncActive();
  }

  /**
   * 「みんなで描く」モードの切り替え。
   * 一人のときは描き込むためにピンチと戻るを使い、みんなのときは一発描きに割り切る、
   * という切り分け。同時に描いていると「誰の 1 手を戻すか」が決められないため。
   */
  private setMultiDraw(enabled: boolean): void {
    this.multiDraw = enabled;
    this.input?.setMultiDraw(enabled);
    if (enabled) {
      // 拡大したまま入ると、隣の子の描く場所が画面外になる。等倍へ戻す。
      this.applyView(IDENTITY);
      // 履歴も持ち越さない(他の子の線が消える事故を作らない)。
      this.surface.dropHistory();
    }
    this.syncMultiDraw();
    this.syncHistoryButtons();
    this.persistProgress();
  }

  private syncMultiDraw(): void {
    this.buttons.get("together")?.classList.toggle("is-active", this.multiDraw);
    this.root.classList.toggle("is-multi-draw", this.multiDraw);
  }

  /**
   * 下敷きの切り替え。ビーズは「マスにしか置けない」モードで、
   * 太さもペン先も持たない(1 マス = 1 ビーズなので太さの概念が無い)。
   */
  private setGridMode(mode: GridMode): void {
    this.gridMode = mode;
    // ビーズへ入ったら、選んでいた色をいちばん近いビーズ色へ寄せる
    // (実物に無い色のまま描かせない)。
    if (GRID_MODES[mode].snap) {
      this.color = nearestBeadColor(this.color);
      this.syncColorChip();
      this.syncSwatches();
    }
    this.penPanel.close();
    this.eraserPanel.close();
    this.syncGridButtons();
    this.persistProgress();
  }

  private get snapToCells(): boolean {
    return GRID_MODES[this.gridMode].snap;
  }

  private syncGridButtons(): void {
    this.colorPanel.element.classList.toggle("is-beads", this.snapToCells);
    this.gridLayer.classList.toggle("is-on", this.gridMode !== "off");
    this.gridLayer.classList.toggle("is-beads", this.gridMode === "beads");
    // ツールバーのボタンには、いま選んでいる下敷きの絵を出す。
    const button = this.buttons.get("grid");
    button?.classList.toggle("is-active", this.gridMode !== "off");
    const icon = button?.querySelector(".icon");
    if (icon != null) icon.innerHTML = GRID_MODES[this.gridMode].iconSvg;
    for (const element of this.gridPanel.element.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.grid === this.gridMode);
    }
  }

  private syncActive(): void {
    for (const [id, button] of this.buttons) {
      const isActive =
        (id === "grid" && this.gridMode !== "off") ||
        (id === "pen" && this.activeTool === "pen") ||
        (id === "eraser" && this.activeTool === "eraser") ||
        (id === "picker" && this.activeTool === "picker") ||
        (id === "fill" && this.activeTool === "fill");
      button.classList.toggle("is-active", isActive);
    }
  }

  private syncSwatches(): void {
    for (const element of this.colorPanel.element.querySelectorAll<HTMLElement>(".swatch")) {
      element.classList.toggle("is-active", element.style.background !== "" && rgbEquals(element.style.background, this.color));
    }
  }

  private syncSizes(): void {
    const mark = (panel: Panel, current: number): void => {
      for (const element of panel.element.querySelectorAll<HTMLElement>(".size-button")) {
        element.classList.toggle("is-active", element.dataset.size === String(current));
      }
    };
    mark(this.penPanel, this.penSize);
    mark(this.eraserPanel, this.eraserSize);
  }

  // --- 描画 -------------------------------------------------------------

  private installInput(canvas: HTMLCanvasElement): void {
    this.input = installPointerInput(canvas, {
      onDown: (id, point) => {
        this.sound.unlock();
        this.guide.hide();
        this.colorPanel.close();
        this.penPanel.close();
        this.eraserPanel.close();
        this.gridPanel.close();

        if (this.activeTool === "picker") {
          // スポイトの道具で吸ったときは「吸ったら描ける」まで含めて 1 動作にする。
          if (this.pickColorAt(point.x, point.y)) this.setActiveTool("pen");
          return;
        }

        if (this.activeTool === "fill") {
          // ビーズは円で置くので画素をたどる塗りつぶしだと背景へ漏れる。マス単位で広げる。
          const rect = this.snapToCells
            ? this.surface.fillCells(point.x, point.y, this.color)
            : this.surface.fill(point.x, point.y, hexToRgba(this.color));
          if (rect !== null) {
            this.surface.commit(rect);
            this.sound.play("shu");
            this.countStroke();
            this.afterHistoryChange();
          }
          return;
        }

        this.lastPoints.set(id, point);
        this.surface.beginStroke(
          id,
          point.x,
          point.y,
          {
            color: this.color,
            size: this.activeTool === "eraser" ? this.eraserSize : this.penSize,
            erase: this.activeTool === "eraser",
            // 消しゴムは太さ一定のまま(消す量が変わると狙って消せない)。
            dynamics: this.activeTool === "eraser" ? undefined : NIB_DEFS[this.nib].dynamics,
            beads: this.snapToCells,
          },
          point.time,
          point.pressure,
        );
      },
      onMove: (id, point) => {
        if (!this.lastPoints.has(id)) return;
        this.lastPoints.set(id, point);
        this.surface.extendStroke(id, point.x, point.y, point.time, point.pressure);
      },
      onGestureStart: (id) => {
        // ピンチに移った瞬間、描きかけの線を捨てる(写真アプリの感覚で触った子を裏切らない)。
        if (id !== undefined) this.lastPoints.delete(id);
        this.surface.cancelStroke(id);
      },
      onGestureChange: (change) => {
        const next = zoomAt(
          panBy(this.view, change.dx, change.dy),
          this.layoutRect(),
          change.centerX,
          change.centerY,
          change.scaleFactor,
        );
        this.applyView(next);
      },
      onGestureEnd: () => {
        this.scheduleSave();
      },
      onPick: (point) => {
        // 右クリックは色を吸うだけ。道具は切り替えない
        // (描いている途中に色だけ変えたい、という使い方のため)。
        this.pickColorAt(point.x, point.y);
      },
      onTwoFingerTap: () => {
        // 2 本指タップ = もどる。ツールバーまで指を運ばずに失敗を消せる。
        if (this.surface.undo()) {
          this.sound.play("shu");
          this.afterHistoryChange();
        }
      },
      onUp: (id) => {
        const last = this.lastPoints.get(id);
        if (last === undefined) return;
        this.lastPoints.delete(id);
        const rect = this.surface.endStroke(id, last.x, last.y);
        if (rect === null) return;
        // みんなで描くモードは履歴を持たない(誰の 1 手を戻すか決められない)。
        this.surface.commit(rect, !this.multiDraw);
        this.countStroke();
        this.afterHistoryChange();
      },
    });
  }

  /** 変換前(等倍・移動なし)の紙の矩形。ピンチの中心計算に要る。 */
  private layoutRect(): { left: number; top: number; width: number; height: number } {
    const rect = this.paperWrap.getBoundingClientRect();
    return {
      left: rect.left - this.view.tx,
      top: rect.top - this.view.ty,
      width: rect.width / this.view.scale,
      height: rect.height / this.view.scale,
    };
  }

  private applyView(next: ViewTransform): void {
    this.view = clampView(next, this.layoutRect(), window.innerWidth, window.innerHeight);
    this.paperWrap.style.transform = toCss(this.view);
    // 拡大中だけ「ぜんぶ見る」を出す。拡大したまま迷子になるのを防ぐ安全弁。
    this.fitButton?.classList.toggle("is-visible", this.view.scale > 1.02);
  }

  /**
   * PC 向けのホイール操作。タッチは 2 本指(ピンチ=拡大 / ドラッグ=移動)で完結するが、
   * PC には指が 2 本無いので割り当てが要る。ブラウザや Figma / Photoshop と同じ作法にする:
   *
   *   ホイール        … 上下に移動
   *   Shift + ホイール … 左右に移動
   *   Ctrl(⌘) + ホイール … 拡大・縮小
   *
   * トラックパッドのピンチは ctrlKey 付きのホイールとして届くので、
   * この割り当てだと「2 本指でこする=移動、つまむ=拡大」が自然に一致する。
   */
  private installWheelZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        if (this.multiDraw) return;
        if (event.ctrlKey || event.metaKey) {
          const factor = Math.exp(-event.deltaY * 0.002);
          this.applyView(zoomAt(this.view, this.layoutRect(), event.clientX, event.clientY, factor));
          return;
        }
        // 等倍のときは動かしても意味がない(紙は画面に収まっている)。
        if (this.view.scale <= 1.001) return;
        const dx = event.shiftKey ? -event.deltaY : -event.deltaX;
        const dy = event.shiftKey ? 0 : -event.deltaY;
        this.applyView(panBy(this.view, dx, dy));
      },
      { passive: false },
    );
  }

  private afterHistoryChange(): void {
    this.syncHistoryButtons();
    this.scheduleSave();
  }

  /** 戻る/進むが効かない時は薄く見せる(押しても壊れないので無効化はしない)。 */
  private syncHistoryButtons(): void {
    // みんなで描くモードでは戻る/進むを持たない。押せないことが見て分かるようにする。
    this.buttons.get("undo")?.classList.toggle("is-dim", this.multiDraw || !this.surface.canUndo);
    this.buttons.get("redo")?.classList.toggle("is-dim", this.multiDraw || !this.surface.canRedo);
  }

  /** 選択中の色をツールバーのボタンに反映する。 */
  private syncColorChip(): void {
    const chip = this.buttons.get("color")?.querySelector<HTMLElement>(".color-chip");
    if (chip !== undefined && chip !== null) chip.style.background = this.color;
  }

  /** その場所の色を吸う。吸えたら true。 */
  private pickColorAt(x: number, y: number): boolean {
    // ビーズはマスの輪を見る。中心は穴(透明)なので紙の色を吸ってしまう。
    const picked = this.snapToCells ? this.surface.pickCell(x, y) : this.surface.pick(x, y);
    if (picked === null) return false;
    this.color = picked;
    this.syncSwatches();
    this.syncColorChip();
    this.sound.play("poko");
    return true;
  }

  private countStroke(): void {
    this.strokeCount += 1;
    this.persistProgress();
    if (this.pendingUnlock !== null) return;
    const unlock = nextUnlock(this.strokeCount, this.ownedTools);
    if (unlock === null) return;
    this.pendingUnlock = unlock;
    this.renderToolbar();
    this.sound.play("poko");
    const chest = this.buttons.get("chest");
    // 吹き出しは道具が増えた瞬間だけ。1 個・7 文字前後(仕様書§5)。
    if (chest !== undefined) this.guide.show("あけてみて", chest);
  }

  private persistProgress(): void {
    saveProgress({
      ownedTools: this.ownedTools,
      strokeCount: this.strokeCount,
      currentWorkId: this.work?.id ?? null,
      gridMode: this.gridMode,
      nib: this.nib,
      multiDraw: this.multiDraw,
    });
  }

  private openChest(unlock: Unlock): void {
    this.pendingUnlock = null;
    this.ownedTools = [...this.ownedTools, unlock.tool];
    this.persistProgress();
    this.renderToolbar();
    this.sound.play("fanfare");
    const button = this.buttons.get(unlock.tool);
    if (button !== undefined) {
      button.classList.add("is-new");
      this.guide.show(unlock.message, button);
    }
  }

  // --- 作品カタログ -----------------------------------------------------

  private async openGallery(): Promise<void> {
    // 開く前に今の絵を確定させる。一覧に「さっきまで描いていた絵」が出ないと混乱する。
    await this.save();
    await this.refreshGallery();
    this.gallery.open();
  }

  private async refreshGallery(): Promise<void> {
    const works =
      this.gallery.currentTab === "works" ? await this.store.list() : await this.store.listDeleted();
    this.gallery.render(works, this.work?.id ?? null, Date.now());
  }

  /**
   * 「ひらいた直後の姿」を履歴に残す。
   * 共用タブレットで他の子の絵に上から描いてしまう事故は、これが残っていれば必ず戻せる
   * (仕様書§7.5)。描き始めてからでは遅いので、開いた時点で撮る。
   */
  private async captureSnapshot(reason: SnapshotReason): Promise<void> {
    const work = this.work;
    if (work === null) return;
    const now = Date.now();
    const updated = appendSnapshot(work, snapshotOf(work, now, reason));
    this.work = updated;
    this.lastSnapshotAt = now;
    try {
      await this.store.put(updated);
    } catch (error) {
      console.warn("りれきの ほぞんに しっぱいしました", error);
    }
  }

  /** 履歴一覧をひらく。 */
  private async showHistory(id: string): Promise<void> {
    const work = await this.store.get(id);
    if (work === null) return;
    this.gallery.renderHistory(work, Date.now());
  }

  /**
   * 選んだ履歴の姿に戻す。戻す直前の姿も履歴に積むので、巻き戻し自体をやり直せる
   * (「戻したらもっとひどくなった」を作らない)。
   */
  private async revertTo(workId: string, snapshotId: string): Promise<void> {
    const work = await this.store.get(workId);
    const snapshot = work?.snapshots.find((item) => item.id === snapshotId);
    const image = snapshot?.pages[0]?.image;
    if (work === null || work === undefined || snapshot === undefined || image === undefined) return;

    // 巻き戻す作品を開いていない場合は、まずそちらへ移る。
    if (this.work?.id !== workId) {
      await this.save();
      this.work = work;
    }
    await this.captureSnapshot("revert");
    await this.surface.restoreFrom(image);
    await this.save();
    this.persistProgress();
    this.syncHistoryButtons();
    this.sound.play("fanfare");
    this.gallery.close();
  }

  private async openWork(id: string): Promise<void> {
    if (id === this.work?.id) {
      this.gallery.close();
      return;
    }
    await this.save();
    const work = await this.store.get(id);
    const image = work?.pages[0]?.image;
    if (work === null || work === undefined || image === undefined) return;
    await this.surface.restoreFrom(image);
    this.work = work;
    this.lastSnapshotAt = work.updatedAt;
    // ひらいた瞬間の姿を残す。この 1 枚が上書き事故の保険になる。
    await this.captureSnapshot("open");
    this.persistProgress();
    this.syncHistoryButtons();
    this.sound.play("poko");
    this.gallery.close();
  }

  private async createWork(): Promise<void> {
    await this.save();
    this.surface.reset();
    // 空の作品をこの場で作って開いた状態にする。
    // 「あたらしく かく」を押した時点で一覧に 1 枚増えていないと、描く前に閉じた子の絵が迷子になる。
    this.work = createWork(await this.surface.toPng(), Date.now(), await this.surface.toThumbnail());
    await this.store.put(this.work);
    this.lastSnapshotAt = this.work.updatedAt;
    this.persistProgress();
    this.syncHistoryButtons();
    this.sound.play("poko");
    this.gallery.close();
  }

  /** 「すてる」= ゴミばこ行き。レコードは消さない(仕様書§7.5)。 */
  private async trashWork(id: string): Promise<void> {
    await this.store.setDeleted(id, true);
    this.sound.play("shu");
    if (id === this.work?.id) {
      // 今ひらいている絵を捨てたら、残っているいちばん新しい絵へ移る。
      // 1 枚も無ければ白紙を用意する(描く場所が無い状態を作らない)。
      const rest = await this.store.list();
      const next = rest[0];
      if (next === undefined) {
        this.surface.reset();
        this.work = createWork(await this.surface.toPng(), Date.now(), await this.surface.toThumbnail());
        await this.store.put(this.work);
      } else {
        const image = next.pages[0]?.image;
        if (image !== undefined) await this.surface.restoreFrom(image);
        this.work = next;
      }
      this.persistProgress();
      this.syncHistoryButtons();
    }
    await this.refreshGallery();
  }

  private async restoreWork(id: string): Promise<void> {
    await this.store.setDeleted(id, false);
    this.sound.play("poko");
    await this.refreshGallery();
  }

  // --- 保存 -------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    const png = await this.surface.toPng();
    const thumbnail = await this.surface.toThumbnail();
    const now = Date.now();
    let work = this.work;
    if (work === null) {
      work = createWork(png, now, thumbnail);
    } else {
      const page = work.pages[0];
      work = {
        ...work,
        updatedAt: now,
        pages: [{ id: page?.id ?? "page-0", image: png }],
        thumbnail,
      };
      // 「前に戻す」用の履歴。描いている間は数分おきに 1 件だけ積む(追記のみ)。
      if (now - this.lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
        work = appendSnapshot(work, snapshotOf(work, now, "auto"));
        this.lastSnapshotAt = now;
      }
    }
    this.work = work;
    this.persistProgress();
    try {
      await this.store.put(work);
    } catch (error) {
      // 保存に失敗しても描画は続けられるべきなので落とさない。
      console.warn("じどうほぞんに しっぱいしました", error);
    }
  }

  private async restore(): Promise<void> {
    try {
      // 前回ひらいていた絵の続きから。無ければいちばん新しい絵。
      const saved = this.currentWorkId === null ? null : await this.store.get(this.currentWorkId);
      const latest = saved !== null && !saved.deleted ? saved : (await this.store.list())[0];
      const image = latest?.pages[0]?.image;
      if (latest === undefined || image === undefined) return;
      await this.surface.restoreFrom(image);
      this.work = latest;
      this.lastSnapshotAt = latest.updatedAt;
      this.syncHistoryButtons();
      // 起動して絵が出た時点も「ひらいた」に含める(別の子が使い始める入口はここ)。
      await this.captureSnapshot("open");
    } catch (error) {
      console.warn("ふくげんに しっぱいしました", error);
    }
  }

  private async exportPng(): Promise<void> {
    this.sound.play("fanfare");
    celebrate(this.stage);
    await this.save();
    const png = await this.surface.toPng();
    const url = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = url;
    link.download = `え-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    // revoke が早すぎると iOS Safari でダウンロードが取り消される。
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** style 属性の色("rgb(61, 55, 48)")と "#3d3730" を比較する。 */
function rgbEquals(styleColor: string, hex: string): boolean {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(styleColor);
  if (match === null) return styleColor.toLowerCase() === hex.toLowerCase();
  const toHex = (value: string): string => Number(value).toString(16).padStart(2, "0");
  return `#${toHex(match[1] ?? "0")}${toHex(match[2] ?? "0")}${toHex(match[3] ?? "0")}` === hex.toLowerCase();
}

const version = document.getElementById("app-version");
// git commit 由来の版文字列がビルド時に差し込まれる(vite.config.ts の define)。
if (version !== null) version.textContent = __APP_VERSION__;

const root = document.getElementById("app");
if (root !== null) new App(root);
