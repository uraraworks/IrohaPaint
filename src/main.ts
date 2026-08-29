// そだつペイント（仮）Phase 0 プロト。
// 受け入れ条件(プロト仕様書§8):
//   1. 開いた瞬間、説明なしで線が描ける
//   2. アイコンを押すとパネルが「ぽよん」と開く
//   3. 描いていると宝箱が現れ、吹き出し 1 個の誘導で道具が増える
//   4. 「かんせい！」で PNG が保存でき、祝福演出が出る
//   5. リロードしても絵が残っている
//   6. iPad(指)と PC(マウス)の両方で成立する
import "./style.css";
import { CRAYON_COLORS, ERASER_SIZE, PEN_SIZES } from "./core/palette.ts";
import { appendSnapshot, createWork, snapshotOf, type WorkRecord } from "./core/model.ts";
import { createWorkStore } from "./core/workStore.ts";
import { hexToRgba, Surface } from "./core/surface.ts";
import { installPointerInput } from "./core/pointerInput.ts";
import { clampView, IDENTITY, panBy, toCss, zoomAt, type ViewTransform } from "./core/viewport.ts";
import { INITIAL_TOOLS, nextUnlock, TOOL_DEFS, type ToolId, type Unlock } from "./core/tools.ts";
import { labelText, renderLabel } from "./ui/label.ts";
import { SoundPlayer } from "./core/sound.ts";
import { GuideBubble } from "./ui/guide.ts";
import { celebrate } from "./ui/celebrate.ts";
import { Panel } from "./ui/panel.ts";

/** 描き終わってから保存するまでの待ち時間。描画中に保存すると重い。 */
const AUTOSAVE_DELAY_MS = 800;
/** 履歴(まえにもどす)を積む間隔。 */
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;

type ActiveTool = "pen" | "eraser" | "picker" | "fill";

class App {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly surface: Surface;
  private readonly sound = new SoundPlayer();
  private readonly guide: GuideBubble;
  private readonly store = createWorkStore();
  private readonly buttons = new Map<string, HTMLElement>();

  private ownedTools: ToolId[] = [...INITIAL_TOOLS];
  private activeTool: ActiveTool = "pen";
  private color = CRAYON_COLORS[0] ?? "#3d3730";
  private penSize = PEN_SIZES[1] ?? 26;
  private strokeCount = 0;
  private pendingUnlock: Unlock | null = null;

  private work: WorkRecord | null = null;
  private saveTimer: number | null = null;
  private lastSnapshotAt = 0;
  private drawing = false;
  /** 紙の見え方(ピンチ拡大・移動)。描画内容には影響しない。 */
  private view: ViewTransform = IDENTITY;

  private colorPanel!: Panel;
  private penPanel!: Panel;

  constructor(root: HTMLElement) {
    this.root = root;

    this.stage = document.createElement("div");
    this.stage.className = "stage";
    const canvas = document.createElement("canvas");
    canvas.className = "paper";
    this.stage.appendChild(canvas);

    this.toolbar = document.createElement("div");
    this.toolbar.className = "toolbar";

    root.append(this.stage, this.toolbar);
    this.surface = new Surface(canvas);
    this.guide = new GuideBubble(document.body);

    this.buildPanels();
    this.renderToolbar();
    this.buildSoundToggle();
    this.installInput(canvas);
    this.installWheelZoom(canvas);
    // PC のキーボードも一応拾う(タッチが主・マウス/キーは後追いという位置づけ)。
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "z") {
        event.preventDefault();
        if (this.surface.undo()) this.scheduleSave();
      }
    });
    void this.restore();
  }

  // --- 組み立て ---------------------------------------------------------

  private buildPanels(): void {
    this.colorPanel = new Panel(document.body, "color-panel");
    const swatches = document.createElement("div");
    swatches.className = "swatches";
    for (const color of CRAYON_COLORS) {
      const swatch = document.createElement("button");
      swatch.className = "swatch";
      swatch.style.background = color;
      swatch.setAttribute("aria-label", `いろ ${color}`);
      swatch.addEventListener("click", () => {
        this.color = color;
        // 色を選んだら描ける状態に戻す(消しゴムのまま色を選ぶ事故を防ぐ)。
        if (this.activeTool === "eraser") this.setActiveTool("pen");
        this.syncSwatches();
        this.sound.play("poko");
        this.colorPanel.close();
      });
      swatches.appendChild(swatch);
    }
    this.colorPanel.element.appendChild(swatches);

    this.penPanel = new Panel(document.body, "pen-panel");
    for (const size of PEN_SIZES) {
      const button = document.createElement("button");
      button.className = "size-button";
      button.dataset.size = String(size);
      const dot = document.createElement("span");
      dot.className = "size-dot";
      // キャンバス実解像度の太さをそのまま出すと大きすぎるので縮めて見せる。
      const shown = Math.max(8, Math.round(size * 0.6));
      dot.style.width = `${shown}px`;
      dot.style.height = `${shown}px`;
      button.appendChild(dot);
      button.setAttribute("aria-label", `ふとさ ${size}`);
      button.addEventListener("click", () => {
        this.penSize = size;
        this.setActiveTool("pen");
        this.syncSizes();
        this.sound.play("poko");
        this.penPanel.close();
      });
      this.penPanel.element.appendChild(button);
    }
    this.syncSwatches();
    this.syncSizes();

    // パネル外タップで閉じる。
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (this.colorPanel.isOpen && !this.colorPanel.element.contains(target) && !this.isToolbarNode(target)) {
        this.colorPanel.close();
      }
      if (this.penPanel.isOpen && !this.penPanel.element.contains(target) && !this.isToolbarNode(target)) {
        this.penPanel.close();
      }
    });
  }

  private isToolbarNode(node: Node): boolean {
    return this.toolbar.contains(node);
  }

  private buildSoundToggle(): void {
    const button = document.createElement("button");
    button.className = "sound-toggle";
    button.textContent = "🔊";
    button.setAttribute("aria-label", "おとの おんおふ");
    button.addEventListener("click", () => {
      this.sound.setEnabled(!this.sound.isEnabled);
      button.textContent = this.sound.isEnabled ? "🔊" : "🔇";
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
  }

  private createToolButton(id: ToolId): HTMLElement {
    const def = TOOL_DEFS[id];
    const button = document.createElement("button");
    button.className = id === "done" ? "tool-button done" : "tool-button";
    button.dataset.tool = id;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = def.icon;
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
    chestIcon.textContent = "🎁";
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
    switch (id) {
      case "pen":
        this.setActiveTool("pen");
        this.penPanel.toggle(button);
        this.sound.play("poko");
        break;
      case "color":
        this.colorPanel.toggle(button);
        this.sound.play("poko");
        break;
      case "eraser":
        this.setActiveTool("eraser");
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
        if (this.surface.undo()) {
          this.sound.play("shu");
          this.scheduleSave();
        }
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

  private syncActive(): void {
    for (const [id, button] of this.buttons) {
      const isActive =
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
    for (const element of this.penPanel.element.querySelectorAll<HTMLElement>(".size-button")) {
      element.classList.toggle("is-active", element.dataset.size === String(this.penSize));
    }
  }

  // --- 描画 -------------------------------------------------------------

  private installInput(canvas: HTMLCanvasElement): void {
    installPointerInput(canvas, {
      onDown: (point) => {
        this.sound.unlock();
        this.guide.hide();
        this.colorPanel.close();
        this.penPanel.close();

        if (this.activeTool === "picker") {
          const picked = this.surface.pick(point.x, point.y);
          if (picked !== null) {
            this.color = picked;
            this.syncSwatches();
            this.sound.play("poko");
            // スポイトは「吸ったら描ける」まで含めて 1 動作にする。
            this.setActiveTool("pen");
          }
          return;
        }

        if (this.activeTool === "fill") {
          const rect = this.surface.fill(point.x, point.y, hexToRgba(this.color));
          if (rect !== null) {
            this.surface.commit(rect);
            this.sound.play("shu");
            this.countStroke();
            this.scheduleSave();
          }
          return;
        }

        this.drawing = true;
        this.surface.beginStroke(point.x, point.y, {
          color: this.color,
          size: this.activeTool === "eraser" ? ERASER_SIZE : this.penSize,
          erase: this.activeTool === "eraser",
        });
      },
      onMove: (point) => {
        if (!this.drawing) return;
        this.surface.extendStroke(point.x, point.y);
      },
      onGestureStart: () => {
        // ピンチに移った瞬間、描きかけの線を捨てる(写真アプリの感覚で触った子を裏切らない)。
        this.drawing = false;
        this.surface.cancelStroke();
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
      onTwoFingerTap: () => {
        // 2 本指タップ = もどる。ツールバーまで指を運ばずに失敗を消せる。
        if (this.surface.undo()) {
          this.sound.play("shu");
          this.scheduleSave();
        }
      },
      onUp: () => {
        if (!this.drawing) return;
        this.drawing = false;
        const rect = this.surface.endStroke();
        if (rect === null) return;
        this.surface.commit(rect);
        this.countStroke();
        this.scheduleSave();
      },
    });
  }

  /** 変換前(等倍・移動なし)の紙の矩形。ピンチの中心計算に要る。 */
  private layoutRect(): { left: number; top: number; width: number; height: number } {
    const rect = this.surface.canvas.getBoundingClientRect();
    return {
      left: rect.left - this.view.tx,
      top: rect.top - this.view.ty,
      width: rect.width / this.view.scale,
      height: rect.height / this.view.scale,
    };
  }

  private applyView(next: ViewTransform): void {
    this.view = clampView(next, this.layoutRect(), window.innerWidth, window.innerHeight);
    this.surface.canvas.style.transform = toCss(this.view);
  }

  /** PC 向け。ホイール(トラックパッドのピンチ含む)で拡大する。 */
  private installWheelZoom(canvas: HTMLCanvasElement): void {
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.002);
        this.applyView(zoomAt(this.view, this.layoutRect(), event.clientX, event.clientY, factor));
      },
      { passive: false },
    );
  }

  private countStroke(): void {
    this.strokeCount += 1;
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

  private openChest(unlock: Unlock): void {
    this.pendingUnlock = null;
    this.ownedTools = [...this.ownedTools, unlock.tool];
    this.renderToolbar();
    this.sound.play("fanfare");
    const button = this.buttons.get(unlock.tool);
    if (button !== undefined) {
      button.classList.add("is-new");
      this.guide.show(unlock.message, button);
    }
  }

  // --- 保存 -------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    const png = await this.surface.toPng();
    const now = Date.now();
    let work = this.work;
    if (work === null) {
      work = createWork(png, now);
    } else {
      const page = work.pages[0];
      work = {
        ...work,
        updatedAt: now,
        pages: [{ id: page?.id ?? "page-0", image: png }],
      };
      // 「まえにもどす」用の履歴。数分おきに 1 件だけ積む(追記のみ)。
      if (now - this.lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
        work = appendSnapshot(work, snapshotOf(work, now));
        this.lastSnapshotAt = now;
      }
    }
    this.work = work;
    try {
      await this.store.put(work);
    } catch (error) {
      // 保存に失敗しても描画は続けられるべきなので落とさない。
      console.warn("じどうほぞんに しっぱいしました", error);
    }
  }

  private async restore(): Promise<void> {
    try {
      const works = await this.store.list();
      const latest = works[0];
      const image = latest?.pages[0]?.image;
      if (latest === undefined || image === undefined) return;
      await this.surface.restoreFrom(image);
      this.work = latest;
      this.lastSnapshotAt = latest.updatedAt;
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

const root = document.getElementById("app");
if (root !== null) new App(root);
