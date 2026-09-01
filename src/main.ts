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
import { cellsFor, GRID_MODES, GRID_MODE_ORDER, type GridMode } from "./core/grid.ts";
import { createPaperTexture, PAPER_KINDS, PAPER_KIND_ORDER, type PaperKind } from "./core/paper.ts";
import {
  appendSnapshot,
  CANVAS_HEIGHT,
  CANVAS_SIZES,
  CANVAS_WIDTH,
  createWork,
  snapshotOf,
  type CanvasSizeId,
  type CellGrid,
  type SnapshotReason,
  type WorkRecord,
} from "./core/model.ts";
import { createWorkStore, requestPersistentStorage } from "./core/workStore.ts";
import { clampPlacement, scaleAt, UNDERLAY_ALPHA, MAX_UNDERLAYS, type UnderlayOpacity, type UnderlayRecord } from "./core/underlay.ts";
import { importUnderlay, UnderlayImportError, type UnderlayImportErrorCode } from "./core/underlayImport.ts";
import { createUnderlayStore, pruneUnderlays, type UnderlayStore } from "./core/underlayStore.ts";
import { hexToRgba, Surface } from "./core/surface.ts";
import { installPointerInput, toCanvasPoint, type GestureChange, type PointerInputControl } from "./core/pointerInput.ts";
import {
  clampView,
  IDENTITY,
  isFullyVisible,
  MIN_SCALE,
  panBy,
  toCss,
  visibleRect,
  zoomAt,
  type Rect,
  type ViewTransform,
} from "./core/viewport.ts";
import {
  CHEST_ICON_SVG,
  FILL_MODE_DEFS,
  FILL_MODE_ORDER,
  INITIAL_TOOLS,
  nextUnlock,
  orderTools,
  TOOL_DEFS,
  TRAILING_TOOLS,
  type LabelPart,
  type ToolId,
  type Unlock,
} from "./core/tools.ts";
import { isShapeMode, type FillMode, type ShapeMode } from "./core/fillShape.ts";
import { labelText, plainText, renderLabel, renderRuby } from "./ui/label.ts";
import { SoundPlayer } from "./core/sound.ts";
import { loadProgress, nextScreenFilter, saveProgress, type ScreenFilterMode } from "./core/progress.ts";
import { GuideBubble } from "./ui/guide.ts";
import { celebrate } from "./ui/celebrate.ts";
import { Panel } from "./ui/panel.ts";
import { Gallery } from "./ui/gallery.ts";
import { installHScroll, makeHScrollPanelRow, type HScrollControl } from "./ui/hscroll.ts";
import {
  CHEVRON_LEFT_SVG,
  CHEVRON_RIGHT_SVG,
  FILTER_DARK_SVG,
  FILTER_NIGHT_SVG,
  FILTER_NORMAL_SVG,
  FILTER_SOFT_SVG,
  FIT_SVG,
  FULLSCREEN_EXIT_SVG,
  FULLSCREEN_SVG,
  MOVE_SVG,
  SOUND_OFF_SVG,
  SOUND_ON_SVG,
  withHiddenBadge,
} from "./ui/icons.ts";
import {
  isFullscreenActive,
  isFullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from "./core/fullscreen.ts";

/** 画面フィルタの段階ごとの見た目(アイコン・aria-label)。 */
const SCREEN_FILTER_DEFS: Readonly<Record<ScreenFilterMode, { icon: string; label: string }>> = {
  normal: { icon: FILTER_NORMAL_SVG, label: "ふつう" },
  soft: { icon: FILTER_SOFT_SVG, label: "やわらか" },
  dark: { icon: FILTER_DARK_SVG, label: "くらい" },
  night: { icon: FILTER_NIGHT_SVG, label: "よる" },
};

/**
 * 下敷きの帯にある「あたらしく取り込む」ボタンのプラス。
 * icons.ts は他画面と共有なので変えず、この画面専用にここへ置く(規格だけ揃える: 32x32 / 線 #3d3730・太さ2)。
 */
const UNDERLAY_ADD_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="16" r="12" fill="#eaf4fc" stroke="#3d3730" stroke-width="2"/>
  <path d="M16 10v12M10 16h12" stroke="#3d3730" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;

/** 濃さ 3 段階のボタン群。UnderlayOpacity のキー順そのまま。 */
const UNDERLAY_OPACITY_ORDER: readonly UnderlayOpacity[] = ["faint", "normal", "strong"];
const UNDERLAY_OPACITY_LABELS: Readonly<Record<UnderlayOpacity, LabelPart[]>> = {
  faint: [{ base: "薄", ruby: "うす" }, { base: "い" }],
  normal: [{ base: "普通", ruby: "ふつう" }],
  strong: [{ base: "濃", ruby: "こ" }, { base: "い" }],
};

/** 「うごかす」ボタンのラベル。 */
const UNDERLAY_MOVE_LABEL: LabelPart[] = [{ base: "動", ruby: "うご" }, { base: "かす" }];

/** 濃さボタンのアイコン。UNDERLAY_ALPHA と同じ値の丸にして、押す前から結果が分かるようにする。 */
function underlayOpacityIconSvg(opacity: UnderlayOpacity): string {
  return `<svg viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="12" fill="#3d3730" fill-opacity="${UNDERLAY_ALPHA[opacity]}"
      stroke="#3d3730" stroke-width="2"/>
  </svg>`;
}

/**
 * 置く操作中、紙を縮小して画面中央に置く倍率。
 * iPad の全画面では紙のまわりに余白がほとんど無く、縮小しないとはみ出しを見せる場所が無い。
 */
const PLACE_PAPER_SCALE = 0.7;

/** 置く操作中、紙の外へはみ出す部分の濃さの掛け率。「今は使われない部分」と分かればよい程度に薄く。 */
const UNDERLAY_OUTSIDE_ALPHA_FACTOR = 0.25;

/** 紙の角丸(.paper の border-radius)に合わせる。置く中の全画面 canvas でのクリップに使う。 */
const PAPER_CORNER_RADIUS = 14;

/** 描き終わってから保存するまでの待ち時間。描画中に保存すると重い。 */
const AUTOSAVE_DELAY_MS = 800;
/** 履歴(まえにもどす)を積む間隔。 */
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;

/**
 * 画面(描画領域)の短い辺がこれ未満ならスマホ扱いにする。
 * タブレットは子どもが使う想定なので今までどおり紙が全部見える状態を保ち、
 * スマホは大人/中学生以降が使う想定なので、一部しか見えなくても画面いっぱいに使う。
 * 例: iPhone 縦 390x844・横 844x390 → 短辺 390 → スマホ扱い。
 *     iPad 縦 820x1180・横 1180x820 → 短辺 820 → タブレット扱い。
 */
const PHONE_SHORT_SIDE_MAX = 500;

type ActiveTool = "pen" | "eraser" | "picker" | "fill";

class App {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  /** 右上に浮かぶ 音/全画面/かくす/フィルタ をまとめる横並びコンテナ(詳細は style.css 側)。 */
  private readonly stageToggles: HTMLElement;
  private readonly paperWrap: HTMLElement;
  private readonly gridLayer: HTMLElement;
  /** 写真の下敷きを描く専用キャンバス。紙のキャンバスには一切描かない(理由は buildStage 参照)。 */
  private readonly underlayCanvas: HTMLCanvasElement;
  private readonly underlayCtx: CanvasRenderingContext2D | null;
  /**
   * 置く操作中だけ出す、画面全体を覆う canvas。
   * 写真を紙の外まで(はみ出し込みで)画面座標で描き、ドラッグ・ピンチもここで拾う
   * (紙を縮小して中央に置くので、掴みたい写真が紙の外にあることが多いため)。
   */
  private readonly placeCanvas: HTMLCanvasElement;
  private readonly placeCtx: CanvasRenderingContext2D | null;
  private placeInput: PointerInputControl | null = null;
  /** 置く操作中だけ placeCanvas に張るホイールリスナーの後始末用。抜けたら abort する。 */
  private placeWheelAbort: AbortController | null = null;
  /** 下敷き選択用の隠しファイル入力。DOM には置くが画面には出さない。 */
  private readonly underlayInput: HTMLInputElement;
  private readonly underlayStore: UnderlayStore = createUnderlayStore();
  private readonly toolbar: HTMLElement;
  private readonly toolbarBar: HTMLElement;
  private toolbarScroll: HScrollControl | null = null;
  /**
   * 「いま開いている作品」の画素寸法。作品ごとに違いうる(WorkRecord.canvasWidth/canvasHeight)ので
   * 定数(CANVAS_WIDTH/CANVAS_HEIGHT)は初期値としてのみ使い、以降はこちらを正とする。
   * Surface・下敷き層・紙テクスチャ層・全体図のすべてがこの値から画素数を決める。
   */
  private canvasWidth: number = CANVAS_WIDTH;
  private canvasHeight: number = CANVAS_HEIGHT;
  private surface: Surface;
  private readonly sound = new SoundPlayer();
  private readonly guide: GuideBubble;
  private readonly store = createWorkStore();
  private readonly buttons = new Map<string, HTMLElement>();

  /** 道具箱の中身。一度増えたら減らない(進捗は localStorage に永続化)。 */
  private ownedTools: ToolId[] = [...INITIAL_TOOLS];
  private activeTool: ActiveTool = "pen";
  private color = CRAYON_COLORS[0] ?? "#3d3730";
  // 段が増えたので、既定は中央(10)。細い 2 段は拡大して描き込む用。
  private penSize = PEN_SIZES[2] ?? 10;
  private eraserSize = ERASER_SIZES[1] ?? 70;
  /** 下敷き。なし / 方眼 / ビーズ / 写真。ビーズはマスにしか置けなくなる。 */
  private gridMode: GridMode = "off";
  /**
   * 紙の種類(ふつう / わら半紙 / キャンバス)。マスとは独立した軸で、
   * 「わら半紙の上に方眼」のように両方選べる(下敷きの帯とは別に常に出す行)。
   */
  private paperKind: PaperKind = "plain";
  /** 紙の質感を描いた canvas。マスの下敷きレイヤーとは別に、乗算で重ねる専用の層。 */
  private paperTextureCanvas!: HTMLCanvasElement;
  private paperTextureCtx: CanvasRenderingContext2D | null = null;
  /**
   * 種類ごとのテクスチャの使い回し用キャッシュ。1748x1181 の生成は軽くないので、
   * 紙を切り替えるたびに作り直さず、種類ごとに 1 回だけ createPaperTexture() を呼ぶ。
   */
  private readonly paperTextureCache = new Map<PaperKind, HTMLCanvasElement | OffscreenCanvas | null>();
  private paperRow!: HTMLElement;
  /** 起動時に復元する下敷き ID(復元後は this.underlayRecord が正)。 */
  private underlayId: string | null = null;
  /** 選んでいる下敷き写真の実体。無ければ写真モードでも何も描かない。 */
  private underlayRecord: UnderlayRecord | null = null;
  /** デコード済みの下敷き画像。毎回の再描画でデコードし直さないよう保持する。 */
  private underlayBitmap: ImageBitmap | null = null;
  /** 取り込み中の二重実行を防ぐガード(数MBの写真のデコードは時間がかかる)。 */
  private importingUnderlay = false;
  /** chooseUnderlay() が store.list() を待っている間の二重実行を防ぐガード。 */
  private choosingUnderlay = false;
  /**
   * 取り込み済みの下敷きが1枚でもあるかどうか。iOS Safari はユーザー操作の直後(同じ
   * 実行の流れの中)でないと input[type=file] のクリックを受け付けないため、写真ボタンの
   * クリック処理では await this.underlayStore.list() を待たずにこのフラグだけを見て
   * 「その場でファイル選択を開くか」を同期的に決める。起動時の復元処理・取り込み成功時・
   * pruneUnderlays() 実行後・下敷き選択時に更新する。
   */
  private hasUnderlays = false;
  /** マスのサブメニューの下に出す、取り込み済みの下敷きを選び直す帯。 */
  private underlayStrip!: HTMLElement;
  private underlayStripTrack!: HTMLElement;
  private underlayStripScroll: HScrollControl | null = null;
  /** 帯のサムネイル用に発行した objectURL。作り直すたびに必ず revoke する(gallery.ts と同じ作法)。 */
  private underlayThumbUrls: string[] = [];
  /** 濃さ3段階 + うごかす、の行。写真が選ばれている間だけ帯の下に出す。 */
  private underlayOpacityRow!: HTMLElement;
  /** 下敷きを「置く」状態。true の間は描かず、1本指ドラッグ/ピンチが下敷き専用になる。 */
  private placingUnderlay = false;
  /** 置く操作中、下敷きをドラッグしている指の pointerId(placeCanvas 側で拾う)。 */
  private placeDragId: number | null = null;
  /** 置く操作中の直前フレームの座標(キャンバス座標系)。差分でドラッグ量を出す。 */
  private placeLastPoint: { x: number; y: number } | null = null;
  private placeDoneButton: HTMLElement | null = null;
  /**
   * なぞった線と下敷き(方眼・ビーズ・写真)を見比べるための「かくす/みせる」トグル。状態は保存しない。
   * 隠したまま次に開くと「下敷きモードなのに何も出ない」という原因の分からない状態になる。
   * 状態は保存せず、起動時・下敷きの切り替え時は必ず見えている側から始める。
   *
   * 抜けるのは「なし」、覗くのは「かくす」。ビーズは升目に吸着する＝描き方が変わるモードなので、
   * 抜けるには「なし」を選ぶ必要がある。かくすは一時的に見えなくするだけで、
   * 隠している間も吸着は続く(完成形を確かめるための機能であって、抜けるための機能ではない)。
   */
  private underlayHiddenByUser = false;
  private underlayToggleButton: HTMLElement | null = null;
  /**
   * 画面フィルタ(目の負担を減らす表示)。表示専用の層を紙・ツールバーの上に重ねるだけで、
   * surface(絵そのもの)には一切触らない。「かくす」と違い状態は保存する(progress.ts 参照)。
   */
  private screenFilter: ScreenFilterMode = "normal";
  private screenFilterButton: HTMLElement | null = null;
  private screenFilterLayer!: HTMLElement;
  /** 置く状態に入る前の view(ピンチの状態)。抜けるときに戻す。viewport.ts の view とは別系統。 */
  private savedView: ViewTransform | null = null;
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

  /**
   * 全体図(ミニマップ)。紙の位置/大きさが変わっている間だけ、いま画面のどこを
   * 見ているかを示す。スマホ標準のスクロールバーと同じ考え方(動かした時だけ出て、
   * 止まったら消える)。押せると事故が起きるので pointer-events: none(style.css 側)。
   */
  private minimap!: HTMLElement;
  private minimapCanvas!: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  private minimapViewportBox!: HTMLElement;
  private minimapVisible = false;
  private minimapHideTimer: number | null = null;
  /**
   * applyInitialView() が構築中に1回目の applyView() を呼ぶ。この最初の1回は
   * 「起動しただけ」であって「動かした」ではないので、全体図を出す対象から除く。
   * コンストラクタの最後(applyInitialView 呼び出し後)に true にする。
   */
  private minimapArmed = false;

  /** 紙のキャンバス要素。置く操作中のピンチ(画面座標→キャンバス座標)の変換に使う。 */
  private paperCanvas!: HTMLCanvasElement;

  private colorPanel!: Panel;
  private penPanel!: Panel;
  private eraserPanel!: Panel;
  private gridPanel!: Panel;
  private fillPanel!: Panel;
  private gallery!: Gallery;

  /**
   * 塗り方。既定は「かこみ」(色の境界まで)。
   *
   * 境界で止まるという理屈は、大人には当たり前でも子どもには見えない。
   * ビーズを並べた上で押すと隙間から全面へ漏れ、線が少しでも切れていれば外へ出る。
   * 「しかく」「まる」は **なぞった範囲がそのまま塗られる**逃げ道で、
   * 押した場所と結果が必ず一致する(バケツをこぼす、という素朴な期待どおりに動く)。
   */
  private fillMode: FillMode = "area";

  /**
   * 「しかく」「まる」でなぞっている最中の状態。触っていなければ null。
   * 塗り方はなぞり始めた時点のものを持つ(途中で切り替わっても形が変わらない)。
   */
  private shapeDrag: { id: number; mode: ShapeMode; x: number; y: number; endX: number; endY: number } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    // 前回までに増えた道具と描いた量を先に戻す。ここを忘れると
    // リロードで道具箱だけ巻き戻り、宝箱がもう一度出てしまう。
    const progress = loadProgress();
    this.ownedTools = progress.ownedTools;
    this.strokeCount = progress.strokeCount;
    this.currentWorkId = progress.currentWorkId;
    this.gridMode = progress.gridMode;
    this.underlayId = progress.underlayId;
    this.nib = progress.nib;
    this.multiDraw = progress.multiDraw;
    this.screenFilter = progress.screenFilter;

    this.stage = document.createElement("div");
    this.stage.className = "stage";
    const canvas = document.createElement("canvas");
    canvas.className = "paper";
    this.paperCanvas = canvas;
    // 方眼・写真の下敷きは「もう1枚の別レイヤー」であって絵そのものではない。
    // 紙のキャンバスには一切描かないので、こうすると PNG 書き出し(キャンバスのみ)にも
    // 作品の保存データ(surface の中身)にも入らない。
    this.paperWrap = document.createElement("div");
    this.paperWrap.className = "paper-wrap";
    this.gridLayer = document.createElement("div");
    this.gridLayer.className = "grid-layer";
    // 下敷き写真は placement がキャンバス座標系(1748x1181)なので、
    // 実ピクセルも同じ大きさで作り CSS で紙と同じ大きさへ伸ばす(drawImage にそのまま渡せる)。
    this.underlayCanvas = document.createElement("canvas");
    this.underlayCanvas.className = "underlay-layer";
    this.underlayCanvas.width = this.canvasWidth;
    this.underlayCanvas.height = this.canvasHeight;
    this.underlayCtx = this.underlayCanvas.getContext("2d");
    // 紙の質感の層。写真の下敷きと同じく実ピクセルを canvasWidth x canvasHeight で作り
    // CSS で紙と同じ大きさへ伸ばす。mix-blend-mode: multiply で重ねる(画面フィルタの
    // 「よる」と同じ仕組み)。
    this.paperTextureCanvas = document.createElement("canvas");
    this.paperTextureCanvas.className = "paper-texture-layer";
    this.paperTextureCanvas.width = this.canvasWidth;
    this.paperTextureCanvas.height = this.canvasHeight;
    this.paperTextureCtx = this.paperTextureCanvas.getContext("2d");
    this.paperWrap.append(canvas, this.gridLayer);
    this.stage.appendChild(this.paperWrap);

    // 置く操作中だけ出す全画面 canvas。stage をそのまま覆う(ツールバーは stage の外なので塞がない)。
    // paperWrap より後ろに足す(≒ 重なり順で上)ことで紙を隠して写真だけ画面座標で描く。
    // ただしこの後に足すサウンド/全画面/ぜんぶ見る/これでいい のボタンより先に足すことで、
    // それらは常にこの上に乗り、置く操作中も押せるままにする。
    this.placeCanvas = document.createElement("canvas");
    this.placeCanvas.className = "place-canvas";
    this.placeCtx = this.placeCanvas.getContext("2d");
    this.stage.appendChild(this.placeCanvas);

    // 音/全画面/かくす/フィルタ の並び。表示・非表示が入れ替わる分は
    // 座標ではなく並び(flex)で詰める(理由は style.css の .stage-toggles 参照)。
    this.stageToggles = document.createElement("div");
    this.stageToggles.className = "stage-toggles";
    this.stage.appendChild(this.stageToggles);

    // 全体図(ミニマップ)。右上は stage-toggles(音/全画面/かくす/フィルタ/ぜんぶ見る)が
    // 並ぶので、左上に置く。押せると描画中の事故になるので pointer-events: none。
    this.minimap = document.createElement("div");
    this.minimap.className = "minimap";
    this.minimapCanvas = document.createElement("canvas");
    this.minimapCanvas.className = "minimap-canvas";
    this.minimapCtx = this.minimapCanvas.getContext("2d");
    this.sizeMinimapCanvas();
    this.minimapViewportBox = document.createElement("div");
    this.minimapViewportBox.className = "minimap-viewport";
    this.minimap.append(this.minimapCanvas, this.minimapViewportBox);
    this.stage.appendChild(this.minimap);

    // 下敷き選択用の隠しファイル入力。写真を選ぶたびに開き直すのではなく、
    // 常に 1 つだけ用意して使い回す。
    this.underlayInput = document.createElement("input");
    this.underlayInput.type = "file";
    this.underlayInput.accept = "image/*";
    // hidden(=display:none)は使わない。iOS Safari は「表示されていない」input への
    // プログラムからのクリックを受け付けないため、画面から見えなくするだけの
    // .underlay-input クラス(style.css 側)を当てる。
    this.underlayInput.className = "underlay-input";
    document.body.appendChild(this.underlayInput);
    this.underlayInput.addEventListener("change", () => {
      const file = this.underlayInput.files?.[0] ?? null;
      // 同じファイルを続けて選び直せるよう毎回リセットする。
      this.underlayInput.value = "";
      // 選ばずに閉じられた場合は file が null になる。この時点ではまだ
      // gridMode を "photo" にしていないので、何もしなければ自然に元のモードのまま残る。
      if (file !== null) void this.importUnderlayFile(file);
    });

    this.toolbar = document.createElement("div");
    this.toolbar.className = "toolbar";
    // 道具が増えても折り返さず、横に流す。折り返すとキャンバスの高さを食うため。
    // 画面外のボタンに気づけるよう、両端に送りボタンを出す(後述の buildToolbarScroll)。
    this.toolbarBar = document.createElement("div");
    this.toolbarBar.className = "toolbar-bar";
    this.toolbarBar.appendChild(this.toolbar);

    root.append(this.stage, this.toolbarBar);
    this.surface = new Surface(canvas, this.canvasWidth, this.canvasHeight);
    // 初期値(定数)と CSS 変数(既定 --paper-w/--paper-h)は既に一致しているはずだが、
    // 将来の作品ごとの寸法切り替えに備えて、起動直後にも一度きちんと合わせておく。
    this.applyCanvasSizeStyle();
    // 描いている最中の末尾を映す層(surface.ts の overlay)。方眼より下に敷く。
    this.paperWrap.insertBefore(this.surface.overlay, this.gridLayer);
    // 重なり順: 紙 → 仮インク(overlay) → 紙テクスチャ → 下敷き写真 → 方眼。方眼はマス目の
    // 目安なので常に一番上に見えていてほしい。紙の質感は絵そのものの一部という位置づけで
    // 下敷き(写真)より下、仮インクより上に置く。
    this.paperWrap.insertBefore(this.paperTextureCanvas, this.gridLayer);
    this.paperWrap.insertBefore(this.underlayCanvas, this.gridLayer);
    this.guide = new GuideBubble(document.body);

    // 画面フィルタの層。position: fixed で viewport を直接覆うので、transform を持つ
    // 祖先(paperWrap の拡大縮小など)の影響を受けないよう stage ではなく body 直下に置く。
    // pointer-events: none で操作は一切邪魔しない(style.css 側)。
    this.screenFilterLayer = document.createElement("div");
    this.screenFilterLayer.className = "screen-filter";
    document.body.appendChild(this.screenFilterLayer);

    this.buildToolbarScroll();
    this.buildPanels();
    this.buildGallery();
    this.renderToolbar();
    this.buildSoundToggle();
    this.buildFullscreenToggle();
    this.buildUnderlayToggle();
    this.buildScreenFilterToggle();
    this.buildFitButton();
    this.buildPlaceDoneButton();
    this.installInput(canvas);
    this.input?.setMultiDraw(this.multiDraw);
    this.installPlaceInput();
    this.installWheelZoom(canvas);
    // 置く中に端末を回転する等でも、はみ出しの見え方が画面に追随するようにする。
    window.addEventListener("resize", () => {
      if (this.placingUnderlay) this.drawPlaceCanvas();
    });
    // 画面の向き・大きさが変わるたびに、スマホ/タブレットの判定と最初の倍率をやり直す
    // (回転で短辺が変わる、外部ディスプレイでウィンドウが伸び縮みする、等)。
    window.addEventListener("resize", () => this.applyInitialView());
    window.addEventListener("orientationchange", () => this.applyInitialView());
    // ここまででレイアウトに要る要素は揃っているので、最初の見え方を決める。
    this.applyInitialView();
    // ここから先の applyView() だけを「動かした」とみなし、全体図の対象にする
    // (起動直後にいきなり出るのを防ぐ)。
    this.minimapArmed = true;
    // PC のキーボードも一応拾う(タッチが主・マウス/キーは後追いという位置づけ)。
    window.addEventListener("keydown", (event) => {
      // 置く操作中に履歴が動くと混乱する(2本指タップの「もどる」と同じ理由で止める)。
      if (this.multiDraw || this.placingUnderlay) return;
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
    // viewport meta の user-scalable=no は iOS Safari が意図的に無視するため効かない。
    // ページ拡大の入口である Safari 独自の gesture イベントを止める。
    // 一度ページが拡大されると指の位置と描画位置がずれ、操作全体が壊れるため。
    // (紙のピンチ・下敷きを置く操作のピンチは pointer events で実装されているので影響しない)
    const blockGesture = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", blockGesture, { passive: false });
    document.addEventListener("gesturechange", blockGesture, { passive: false });
    document.addEventListener("gestureend", blockGesture, { passive: false });
    document.addEventListener(
      "touchmove",
      (event: TouchEvent) => {
        if (event.touches.length >= 2) event.preventDefault();
      },
      { passive: false },
    );
    void this.restore();
    void this.restoreUnderlay();
    void this.refreshHasUnderlays();
    // 作品が勝手に消えないよう永続化を頼んでおく(結果は待たない)。
    void requestPersistentStorage();
  }

  // --- 作品ごとの寸法 -----------------------------------------------------

  /**
   * 全体図(ミニマップ)の実ピクセル数を、いまの canvasWidth/canvasHeight の比率に合わせて決める。
   *
   * 元の実装は「横 120px 固定、縦は比率なり」だった。横長(1748x1181)前提ならそれで
   * 破綻しないが、縦長の作品では縦がいくらでも伸びてしまう(例: 1000x2000 なら
   * 120 x 240 になり、ツールバー等を圧迫する)。長辺を 120px に収める形にしておけば、
   * どちらの向きでも全体図が同じ大きさ感になる。
   */
  private sizeMinimapCanvas(): void {
    const portrait = this.canvasHeight > this.canvasWidth;
    if (portrait) {
      this.minimapCanvas.height = 120;
      this.minimapCanvas.width = Math.round((120 * this.canvasWidth) / this.canvasHeight);
    } else {
      this.minimapCanvas.width = 120;
      this.minimapCanvas.height = Math.round((120 * this.canvasHeight) / this.canvasWidth);
    }
  }

  /**
   * 紙の縦横比を CSS 側(aspect-ratio: var(--paper-w) / var(--paper-h))へ反映する。
   * ビーズ／ドット絵の下敷き格子も、マス数(cols/rows)を CSS 変数として渡す。
   * cellsFor() は縦長で cols/rows を入れ替えて返すので、ここで流し込めば
   * CSS 側は「1 マス = 100%/cols x 100%/rows」の百分率だけで済み、紙の
   * aspect-ratio が既に正しい向きになっているぶん、そのまま正方形のマスになる。
   */
  private applyCanvasSizeStyle(): void {
    document.documentElement.style.setProperty("--paper-w", String(this.canvasWidth));
    document.documentElement.style.setProperty("--paper-h", String(this.canvasHeight));
    const beadGrid = cellsFor("beads", this.canvasWidth, this.canvasHeight);
    const dotGrid = cellsFor("dot", this.canvasWidth, this.canvasHeight);
    if (beadGrid !== null) {
      document.documentElement.style.setProperty("--bead-cols", String(beadGrid.cols));
      document.documentElement.style.setProperty("--bead-rows", String(beadGrid.rows));
    }
    if (dotGrid !== null) {
      document.documentElement.style.setProperty("--dot-cols", String(dotGrid.cols));
      document.documentElement.style.setProperty("--dot-rows", String(dotGrid.rows));
    }
  }

  /**
   * 開く/新規作成した作品の寸法(WorkRecord.canvasWidth/canvasHeight)を、実際の描画まわり
   * (Surface・下敷き層・紙テクスチャ層・全体図・CSS 変数)へ反映する。
   *
   * Surface は内部に undo 用の控え・仮インク層などを寸法固定で持って生成するため、
   * 寸法そのものが変わる場合は作り直す以外に安全な手段が無い(単純に width/height を
   * 書き換えると中身が消え、控えとも食い違う)。作り直すと overlay も新しい要素になるので、
   * DOM 上の古い overlay を新しいものへ差し替える。
   *
   * ギャラリーの「はがき よこ/たて」ボタンや、寸法違いの作品をひらく操作から呼ばれる。
   * 同じ寸法の作品を続けて開いた場合は早期 return し、Surface の作り直しを避ける。
   */
  private applyCanvasSize(width: number, height: number): void {
    if (width === this.canvasWidth && height === this.canvasHeight) return;
    this.canvasWidth = width;
    this.canvasHeight = height;

    this.paperWrap.removeChild(this.surface.overlay);
    this.surface = new Surface(this.paperCanvas, width, height);
    // 重なり順は組み立て時と同じ: 紙 → 仮インク(overlay) → 紙テクスチャ → 下敷き写真 → 方眼。
    this.paperWrap.insertBefore(this.surface.overlay, this.paperTextureCanvas);

    this.underlayCanvas.width = width;
    this.underlayCanvas.height = height;
    this.paperTextureCanvas.width = width;
    this.paperTextureCanvas.height = height;
    // 紙テクスチャは寸法込みで焼くので、寸法が変わったキャッシュは使い回せない。
    // syncPaperLayer() 側が getPaperTexture() 経由で作り直す。
    this.paperTextureCache.clear();

    this.sizeMinimapCanvas();
    this.applyCanvasSizeStyle();
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
    this.fillPanel = this.createFillPanel();
    this.syncSwatches();
    this.syncSizes();
    this.syncNibs();
    this.syncGridButtons();
    this.syncFillModes();
    this.syncPaperLayer();

    // パネル外タップで閉じる。
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (this.isToolbarNode(target)) return;
      for (const panel of [this.colorPanel, this.penPanel, this.eraserPanel, this.gridPanel, this.fillPanel]) {
        if (panel.isOpen && !panel.element.contains(target)) panel.close();
      }
    });

    // 画面の回転・リサイズで開いているパネルだけ位置を計算し直す(1箇所にまとめる)。
    const repositionOpenPanels = (): void => {
      for (const panel of [this.colorPanel, this.penPanel, this.eraserPanel, this.gridPanel, this.fillPanel]) {
        panel.reposition();
      }
    };
    window.addEventListener("resize", repositionOpenPanels);
    window.addEventListener("orientationchange", repositionOpenPanels);
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

  /**
   * 紙の種類(ふつう / わら半紙 / キャンバス)を選ぶ行。マスの行とは別の段で常に出す
   * (写真のときだけ出る帯・濃さの行とは違い、常に表示)。見た目・作り方はマスの行と
   * 揃える(nib-button を並べるだけ)。
   */
  private createPaperRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "paper-row";
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
    // 縦に伸び、狭い画面では選ぶために絵が見えなくなる。送りボタンは付けない
    // (makeHScrollPanelRow のコメント参照。溢れている行が複数あると送りボタンが
    // 縦に並んでしまうため、端をぼかして先があることだけ示す)。
    const { track } = makeHScrollPanelRow(row);
    for (const id of PAPER_KIND_ORDER) {
      const def = PAPER_KINDS[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.paper = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", plainText(def.label));
      // 紙とマスは独立した軸。ここでは gridMode に一切触らないので、
      // 「わら半紙の上に方眼」のように両方選べる。
      button.addEventListener("click", () => {
        this.setPaperKind(id);
        this.sound.play(id === "plain" ? "shu" : "poko");
      });
      track.appendChild(button);
    }
    this.paperRow = row;
    return row;
  }

  /** 紙の種類を切り替える。開いている作品にも記録して保存する。 */
  private setPaperKind(kind: PaperKind): void {
    this.paperKind = kind;
    this.syncPaperLayer();
    if (this.work !== null) {
      this.work = { ...this.work, paperKind: kind, updatedAt: Date.now() };
      void this.store.put(this.work);
    }
  }

  /** 種類ごとのテクスチャを 1 回だけ作って使い回す(1748x1181 の生成は軽くないため)。 */
  private getPaperTexture(kind: PaperKind): HTMLCanvasElement | OffscreenCanvas | null {
    if (!this.paperTextureCache.has(kind)) {
      this.paperTextureCache.set(kind, createPaperTexture(kind, this.canvasWidth, this.canvasHeight));
    }
    return this.paperTextureCache.get(kind) ?? null;
  }

  /** 紙テクスチャの層と、紙の行のボタンの見た目(is-active)を現在の paperKind に揃える。 */
  private syncPaperLayer(): void {
    const texture = this.getPaperTexture(this.paperKind);
    this.paperTextureCanvas.classList.toggle("is-on", texture !== null);
    if (this.paperTextureCtx !== null) {
      this.paperTextureCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
      if (texture !== null) this.paperTextureCtx.drawImage(texture as CanvasImageSource, 0, 0);
    }
    for (const element of this.paperRow.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.paper === this.paperKind);
    }
  }

  /** 開いている作品(this.work)の paperKind を this.paperKind・表示へ反映する。 */
  private applyWorkPaper(): void {
    this.paperKind = this.work?.paperKind ?? "plain";
    this.syncPaperLayer();
  }

  /**
   * 下敷きを選ぶパネル(なし / 方眼 / ビーズ)。将来のドット絵モードもここへ足す。
   *
   * 行の並びは 紙 → マス → (写真のときだけ)一覧 → 濃さ の順。紙はマスとは独立した軸
   * (下敷きの帯と違って常に表示)なので、専用の行(createPaperRow)を別に持つ。
   */
  /**
   * 「塗る」の塗り方を選ぶパネル。ペン先の段と同じ作り(nib-button を横に並べる)にして、
   * 操作を覚え直させない。3 つしかないので送りボタンは出ない。
   */
  private createFillPanel(): Panel {
    const panel = new Panel(document.body, "fill-panel");
    const row = document.createElement("div");
    row.className = "fill-mode-row";
    const { track } = makeHScrollPanelRow(row);
    for (const id of FILL_MODE_ORDER) {
      const def = FILL_MODE_DEFS[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.fillMode = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", def.description);
      button.addEventListener("click", () => {
        this.fillMode = id;
        this.setActiveTool("fill");
        this.syncFillModes();
        this.sound.play("poko");
      });
      track.appendChild(button);
    }
    panel.element.appendChild(row);
    return panel;
  }

  /**
   * 塗り方の選択状態を揃える。
   * 選んだ塗り方は「塗る」ボタン自体のアイコンにも出す(色ボタンが今の色を出すのと同じ)。
   * パネルを開かなくても、いま押したら何が起きるかが分かる。
   */
  private syncFillModes(): void {
    for (const element of this.fillPanel.element.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.fillMode === this.fillMode);
    }
    const icon = this.buttons.get("fill")?.querySelector(".icon");
    if (icon !== null && icon !== undefined) {
      icon.innerHTML = this.fillMode === "area" ? (TOOL_DEFS.fill.iconSvg ?? "") : FILL_MODE_DEFS[this.fillMode].iconSvg;
    }
  }

  private createGridPanel(): Panel {
    const panel = new Panel(document.body, "grid-panel");
    panel.element.appendChild(this.createPaperRow());
    const gridRow = document.createElement("div");
    gridRow.className = "grid-mode-row";
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
    // 縦に伸び、狭い画面では選ぶために絵が見えなくなる。送りボタンは付けない
    // (makeHScrollPanelRow のコメント参照。溢れている行が複数あると送りボタンが
    // 縦に並んでしまうため、端をぼかして先があることだけ示す)。
    const { track: gridTrack } = makeHScrollPanelRow(gridRow);
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
        // マスは選んで終わりではなく、その先に選択肢が続く(写真なら「どの写真」「濃さ」「動かす」)。
        // 選んだ瞬間に、その選択で出てくるはずのものが入ったパネルが閉じてしまうのは噛み合わない。
        // 見比べて決める種類の選択でもあるので、開いたまま切り替えられる方がよい。
        // 色・ペン先・消しゴムは「選んだら次は描く」で終わりなので、今まで通り閉じる。
        if (id === "photo") {
          // 写真だけは特別扱い。下敷きが無ければまずファイルを選ばせる
          // (選ばれるまでは gridMode を変えないので、キャンセルされても
          // 「写真モードなのに何も無い」状態にはならない)。
          //
          // iOS Safari はユーザー操作から await を1つでも挟むと、その先で呼ぶ
          // input.click() がユーザー操作扱いされずファイル選択が開かない(黙って
          // 何も起きない)。なので分岐そのものを await なしの同期処理にする:
          // - underlayRecord があるものはそのまま表示(await なし)
          // - 無いが hasUnderlays が true なら chooseUnderlay() に投げて直近のものを
          //   開く(この先はファイル選択を開かないので await を挟んでよい)
          // - hasUnderlays も false なら、この click ハンドラの実行の中で
          //   同期的に underlayInput.click() を呼ぶ
          if (this.underlayRecord !== null) {
            this.setGridMode("photo");
            this.sound.play("poko");
            return;
          }
          if (this.hasUnderlays) {
            void this.chooseUnderlay();
            return;
          }
          this.underlayInput.click();
          return;
        }
        this.setGridMode(id);
        this.sound.play(id === "off" ? "shu" : "poko");
      });
      gridTrack.appendChild(button);
    }
    panel.element.appendChild(gridRow);
    // 写真が選ばれている間だけ、取り込み済みの下敷きを選び直す帯を出す(refreshUnderlayStrip で中身を作る)。
    // パネルの flex-wrap を利用して独立した 1 行にするため CSS 側で flex-basis: 100% にしてある。
    // 帯自身は左右の送りボタンを乗せる外枠、実際にスクロールするのは中の underlayStripTrack。
    this.underlayStrip = document.createElement("div");
    this.underlayStrip.className = "underlay-strip";
    this.underlayStripTrack = document.createElement("div");
    this.underlayStripTrack.className = "underlay-strip-track";
    const arrowLeft = document.createElement("button");
    arrowLeft.className = "underlay-strip-arrow underlay-strip-arrow-left";
    arrowLeft.innerHTML = CHEVRON_LEFT_SVG;
    arrowLeft.setAttribute("aria-label", "まえの しゃしん");
    const arrowRight = document.createElement("button");
    arrowRight.className = "underlay-strip-arrow underlay-strip-arrow-right";
    arrowRight.innerHTML = CHEVRON_RIGHT_SVG;
    arrowRight.setAttribute("aria-label", "つぎの しゃしん");
    this.underlayStrip.append(arrowLeft, this.underlayStripTrack, arrowRight);
    this.underlayStripScroll = installHScroll(this.underlayStripTrack, { left: arrowLeft, right: arrowRight });
    panel.element.appendChild(this.underlayStrip);
    // 濃さ3段階 + うごかす。帯とおなじく flex-basis:100% で独立した行にする(CSS 側)。
    panel.element.appendChild(this.createUnderlayOpacityRow());
    return panel;
  }

  /**
   * 濃さ3段階(うすい/ふつう/こい) + うごかす、の行。
   * .grid-panel の幅上限(404px)がちょうど 4 ボタン分の実測値なので、既存の
   * なし/方眼/ビーズ/写真の行と同じ作り方(nib-button を並べるだけ)で 1 行に収まる。
   */
  private createUnderlayOpacityRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "underlay-opacity-row";
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
    // 縦に伸び、狭い画面では選ぶために絵が見えなくなる。送りボタンは付けない
    // (makeHScrollPanelRow のコメント参照。溢れている行が複数あると送りボタンが
    // 縦に並んでしまうため、端をぼかして先があることだけ示す)。
    const { track } = makeHScrollPanelRow(row);
    for (const opacity of UNDERLAY_OPACITY_ORDER) {
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.underlayOpacity = opacity;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = underlayOpacityIconSvg(opacity);
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(UNDERLAY_OPACITY_LABELS[opacity]));
      button.append(icon, label);
      button.setAttribute("aria-label", `こさ ${plainText(UNDERLAY_OPACITY_LABELS[opacity])}`);
      button.addEventListener("click", () => this.setUnderlayOpacity(opacity));
      track.appendChild(button);
    }
    const move = document.createElement("button");
    move.className = "nib-button";
    move.dataset.underlayMove = "true";
    const moveIcon = document.createElement("span");
    moveIcon.className = "icon";
    moveIcon.innerHTML = MOVE_SVG;
    const moveLabel = document.createElement("span");
    moveLabel.className = "label";
    moveLabel.appendChild(renderRuby(UNDERLAY_MOVE_LABEL));
    move.append(moveIcon, moveLabel);
    move.setAttribute("aria-label", `したじきを ${plainText(UNDERLAY_MOVE_LABEL)}`);
    move.addEventListener("click", () => {
      this.enterPlacingUnderlay();
      this.sound.play("poko");
    });
    track.appendChild(move);
    this.underlayOpacityRow = row;
    return row;
  }

  /** 濃さを選ぶ。即座に反映しつつレコードにも保存する(既定は normal のまま)。 */
  private setUnderlayOpacity(opacity: UnderlayOpacity): void {
    if (this.underlayRecord === null) return;
    this.underlayRecord = { ...this.underlayRecord, opacity };
    this.drawUnderlay();
    void this.underlayStore.put(this.underlayRecord);
    this.sound.play("poko");
  }

  /** 濃さ行の表示・選択状態を揃える。写真が選ばれている間だけ出す。 */
  private syncUnderlayOpacityRow(): void {
    this.underlayOpacityRow.classList.toggle("is-visible", this.gridMode === "photo");
    for (const element of this.underlayOpacityRow.querySelectorAll<HTMLElement>(".nib-button")) {
      if (element.dataset.underlayOpacity === undefined) continue;
      element.classList.toggle("is-active", element.dataset.underlayOpacity === this.underlayRecord?.opacity);
    }
  }

  /**
   * 「マス」から写真を選んだときの、取り込み済みが既にある場合の入口。
   * 呼び出し元(写真ボタンの click ハンドラ)が「underlayRecord が無く、
   * hasUnderlays が true」のときだけ await なしで呼ぶので、ここでは
   * store から直近に使ったものを選び直す処理だけを行う(ファイル選択を
   * 開く分岐は呼び出し元の同期処理側にあるので、ここは await をまたいでよい)。
   */
  private async chooseUnderlay(): Promise<void> {
    if (this.choosingUnderlay) return;
    this.choosingUnderlay = true;
    try {
      const records = await this.underlayStore.list();
      // hasUnderlays が古い情報のまま呼ばれた場合の保険。ファイル選択が開かない
      // (すでに await をまたいでいる)が、データの不整合は解消しておく。
      this.hasUnderlays = records.length > 0;
      if (records.length === 0) {
        this.underlayInput.click();
        return;
      }
      // 複数あれば直近に使ったものを選ぶ。選び直し(lastUsedAt 更新・progress の
      // underlayId 更新・帯の作り直し)は selectUnderlay() をそのまま使い回す。
      const latest = records.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a));
      this.setGridMode("photo");
      await this.selectUnderlay(latest);
      // setGridMode の時点では underlayRecord がまだ null なので、underlayCanvas の
      // is-on 判定(gridMode === "photo" && underlayRecord !== null)が false のまま
      // 取り残される。selectUnderlay が underlayRecord を埋めた後にもう一度揃える。
      this.syncGridButtons();
    } finally {
      this.choosingUnderlay = false;
    }
  }

  private createNibRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "nib-row";
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
    // 縦に伸び、狭い画面では選ぶために絵が見えなくなる。送りボタンは付けない
    // (makeHScrollPanelRow のコメント参照。溢れている行が複数あると送りボタンが
    // 縦に並んでしまうため、端をぼかして先があることだけ示す)。
    const { track } = makeHScrollPanelRow(row);
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
      track.appendChild(button);
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
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す。折り返すとパネルが
    // 縦に伸び、狭い画面では選ぶために絵が見えなくなる。送りボタンは付けない
    // (makeHScrollPanelRow のコメント参照。溢れている行が複数あると送りボタンが
    // 縦に並んでしまうため、端をぼかして先があることだけ示す)。
    const { track } = makeHScrollPanelRow(row);
    for (const size of sizes) {
      const button = document.createElement("button");
      button.className = "size-button";
      button.dataset.size = String(size);
      const dot = document.createElement("span");
      dot.className = "size-dot";
      // 実際の太さをそのまま出すと、太い側は大きすぎ、細い側は差が見えない。
      // 平方根で圧縮して、どの段も隣との違いが分かる大きさにする。
      const shown = Math.round(4 + Math.sqrt(size) * 4);
      dot.style.width = `${shown}px`;
      dot.style.height = `${shown}px`;
      button.appendChild(dot);
      button.setAttribute("aria-label", `ふとさ ${size}`);
      button.addEventListener("click", () => {
        onPick(size);
        this.syncSizes();
        panel.close();
      });
      track.appendChild(button);
    }
    panel.element.appendChild(row);
    return panel;
  }

  private isToolbarNode(node: Node): boolean {
    return this.toolbar.contains(node);
  }

  /**
   * ツールバーの横スクロール。
   *
   * 道具は増えていくので折り返すとキャンバスの高さを食う。かといって単に横スクロールに
   * すると「画面外にボタンがある」ことに気づけないので、**両端に送りボタンを出す**。
   * 指ではそのままスワイプでき、マウスでもドラッグで流せる。
   */
  private buildToolbarScroll(): void {
    const makeArrow = (side: "left" | "right", icon: string): HTMLElement => {
      const button = document.createElement("button");
      button.className = `toolbar-arrow toolbar-arrow-${side}`;
      button.innerHTML = icon;
      button.setAttribute("aria-label", side === "left" ? "まえの どうぐ" : "つぎの どうぐ");
      return button;
    };
    const left = makeArrow("left", CHEVRON_LEFT_SVG);
    const right = makeArrow("right", CHEVRON_RIGHT_SVG);
    this.toolbarBar.append(left, right);
    this.toolbarScroll = installHScroll(this.toolbar, { left, right });
  }

  /** 送り先が無い側の矢印は出さない(押せるのに何も起きないボタンを作らない)。内容が増減した直後に呼ぶ。 */
  private syncToolbarArrows(): void {
    this.toolbarScroll?.sync();
  }

  private buildGallery(): void {
    this.gallery = new Gallery(document.body, {
      onOpen: (id) => void this.openWork(id),
      onCreate: (sizeId) => void this.createWork(sizeId),
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
    button.innerHTML = FIT_SVG;
    const label = document.createElement("span");
    label.appendChild(renderRuby([{ base: "全部", ruby: "ぜんぶ" }]));
    button.appendChild(label);
    button.setAttribute("aria-label", "ぜんぶ見る");
    button.addEventListener("click", () => {
      this.applyView(IDENTITY);
      this.sound.play("shu");
    });
    this.stageToggles.appendChild(button);
    this.fitButton = button;
  }

  /**
   * なぞった線と下敷き(方眼・ビーズ・写真)を見比べるための「かくす/みせる」トグル。全画面・音
   * ボタンと同じ並び(紙の右上)に置く。下敷きが「なし」以外のときだけ出す
   * (置く操作中は動かしている対象を隠す意味が無いので、その間も出さない)。
   */
  private buildUnderlayToggle(): void {
    const button = document.createElement("button");
    button.className = "sound-toggle underlay-toggle";
    button.setAttribute("aria-label", "かくす");
    button.addEventListener("click", () => {
      this.underlayHiddenByUser = !this.underlayHiddenByUser;
      this.syncUnderlayToggle();
      this.sound.play("poko");
    });
    this.stageToggles.appendChild(button);
    this.underlayToggleButton = button;
  }

  /** 隠す/見せるボタンの表示・見た目・下敷き自体の表示/非表示を揃える。 */
  private syncUnderlayToggle(): void {
    // 写真だけは実体(underlayRecord)が無いと隠しようがないので別条件。方眼・ビーズは
    // gridMode がそのまま「置いてある」印になる。
    const hasUnderlay = this.gridMode === "grid" || this.gridMode === "beads" ||
      this.gridMode === "dot" || (this.gridMode === "photo" && this.underlayRecord !== null);
    const visible = hasUnderlay && !this.placingUnderlay;
    this.underlayToggleButton?.classList.toggle("is-visible", visible);
    if (this.underlayToggleButton !== null) {
      // ボタンのアイコンは「目」ではなく、今の下敷きそのもの(GRID_MODES 側の絵柄をそのまま使う)。
      // 隠しているときは、音の ON/OFF と同じ作法で ✕ を重ねる。
      const baseIcon = GRID_MODES[this.gridMode].iconSvg;
      this.underlayToggleButton.innerHTML = this.underlayHiddenByUser ? withHiddenBadge(baseIcon) : baseIcon;
      this.underlayToggleButton.setAttribute("aria-label", this.underlayHiddenByUser ? "みせる" : "かくす");
    }
    // 濃さ・配置は underlayRecord 側の状態なので一切触らない。表示を止めるだけ。
    this.underlayCanvas.classList.toggle("is-hidden-by-user", this.underlayHiddenByUser);
    // 方眼・ビーズの升目線も同じトグル 1 つで制御する(状態を 2 つに分けない)。
    this.gridLayer.classList.toggle("is-hidden-by-user", this.underlayHiddenByUser);
  }

  /**
   * 下敷きを「置く」状態のあいだだけ出る「これでいい」。
   * ツールバーの上あたり(指が届く位置)に置く。押すと置く状態を抜けて配置を保存する。
   */
  private buildPlaceDoneButton(): void {
    const button = document.createElement("button");
    button.className = "place-done-button";
    button.textContent = "これでいい";
    button.setAttribute("aria-label", "したじきの いちを けってい");
    button.addEventListener("click", () => {
      this.exitPlacingUnderlay();
      this.sound.play("poko");
    });
    this.stage.appendChild(button);
    this.placeDoneButton = button;
  }

  /**
   * 画面フィルタ(目の負担を減らす表示)の切り替えボタン。全画面・音・かくすと同じ並び(紙の右上)。
   * 押すたびに ふつう → やわらか → くらい → よる → ふつう … と一周する。
   */
  private buildScreenFilterToggle(): void {
    const button = document.createElement("button");
    button.className = "sound-toggle filter-toggle";
    button.addEventListener("click", () => {
      this.screenFilter = nextScreenFilter(this.screenFilter);
      this.syncScreenFilter();
      this.persistProgress();
      this.sound.play("poko");
    });
    this.stageToggles.appendChild(button);
    this.screenFilterButton = button;
    this.syncScreenFilter();
  }

  /** 画面フィルタボタンの見た目と、実際に覆う層のクラスを今の段階に合わせる。 */
  private syncScreenFilter(): void {
    const def = SCREEN_FILTER_DEFS[this.screenFilter];
    if (this.screenFilterButton !== null) {
      this.screenFilterButton.innerHTML = def.icon;
      this.screenFilterButton.setAttribute("aria-label", def.label);
    }
    this.screenFilterLayer.className = `screen-filter is-${this.screenFilter}`;
  }

  /**
   * 全画面ボタン。使える環境にだけ出す。
   * iPhone の WebKit は <video> 以外の全画面に対応しておらず、押しても何も起きない
   * (ホーム画面に追加すれば全画面で開ける)。押して無反応なボタンは置かない。
   */
  private buildFullscreenToggle(): void {
    if (!isFullscreenSupported()) return;
    const button = document.createElement("button");
    button.className = "sound-toggle fullscreen-toggle";
    const sync = (): void => {
      const active = isFullscreenActive();
      button.innerHTML = active ? FULLSCREEN_EXIT_SVG : FULLSCREEN_SVG;
      button.setAttribute("aria-label", active ? "ぜんめんを やめる" : "ぜんめんに する");
    };
    sync();
    button.addEventListener("click", () => {
      void toggleFullscreen();
      this.sound.play("poko");
    });
    // Esc やシステム側の操作で抜けたときも見た目を合わせる。
    onFullscreenChange(sync);
    this.stageToggles.appendChild(button);
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
    this.stageToggles.appendChild(button);
  }

  private renderToolbar(): void {
    this.toolbar.textContent = "";
    this.buttons.clear();
    // 作品・完成は常に末尾固定(orderTools 参照)。宝箱は「まだ受け取っていない道具」を
    // 示す一時的なボタンなので、固定末尾の手前(描く道具の続き)に置く。
    const ordered = orderTools(this.ownedTools);
    const trailingSet = new Set(TRAILING_TOOLS);
    for (const id of ordered) {
      if (trailingSet.has(id)) continue;
      this.toolbar.appendChild(this.createToolButton(id));
    }
    if (this.pendingUnlock !== null) this.toolbar.appendChild(this.createChestButton(this.pendingUnlock));
    for (const id of ordered) {
      if (!trailingSet.has(id)) continue;
      this.toolbar.appendChild(this.createToolButton(id));
    }
    this.syncActive();
    this.syncHistoryButtons();
    this.syncGridButtons();
    this.syncFillModes();
    this.syncMultiDraw();
    this.syncToolbarArrows();
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
              : id === "fill"
                ? this.fillPanel
                : null;
    for (const panel of [this.colorPanel, this.penPanel, this.eraserPanel, this.gridPanel, this.fillPanel]) {
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
        // 塗り方(かこみ / しかく / まる)を選べるようにする。ペンの太さと同じ扱い。
        this.fillPanel.toggle(button);
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
        if (this.gridPanel.isOpen) this.onGridPanelOpened();
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
    // 下敷きを切り替えたら「かくす」は必ずリセットする。隠した状態は持ち越さない
    // (別の下敷きを選んだら見えている状態から始める。保存もしない方針と揃える)。
    this.underlayHiddenByUser = false;
    // ビーズへ入ったら、選んでいた色をいちばん近いビーズ色へ寄せる
    // (実物に無い色のまま描かせない)。ドット絵は実物の制約が無いので寄せない。
    if (mode === "beads") {
      this.color = nearestBeadColor(this.color);
      this.syncColorChip();
      this.syncSwatches();
    }
    this.penPanel.close();
    this.eraserPanel.close();
    this.syncGridButtons();
    this.persistProgress();
  }

  /** マスに吸着するモードなら、その格子。自由に描けるモードでは null。 */
  private get cellGrid(): CellGrid | null {
    return cellsFor(this.gridMode, this.canvasWidth, this.canvasHeight);
  }

  private get snapToCells(): boolean {
    return this.cellGrid !== null;
  }

  private syncGridButtons(): void {
    // 色見本をビーズの色に差し替えるのは beads だけ。ドット絵は実物の制約が無いので
    // ふつうの色見本のまま使わせる。
    this.colorPanel.element.classList.toggle("is-beads", this.gridMode === "beads");
    // マス目の線は grid / beads / dot だけの絵柄。photo は underlayCanvas 側で見せるので、
    // ここでは重ねない(重ねると写真の上に無関係な線が乗ってしまう)。
    this.gridLayer.classList.toggle(
      "is-on",
      this.gridMode === "grid" || this.gridMode === "beads" || this.gridMode === "dot",
    );
    this.gridLayer.classList.toggle("is-beads", this.gridMode === "beads");
    this.gridLayer.classList.toggle("is-dot", this.gridMode === "dot");
    // ドット絵のときだけ拡大の補間を切る。ここを滑らかに伸ばすと、せっかく四角で
    // 置いたマスの角がぼやけて、ドット絵にした意味が無くなる。
    this.paperCanvas.classList.toggle("is-pixelated", this.gridMode === "dot");
    // 写真の下敷きは、下敷きが実際にあるときだけ見せる。
    this.underlayCanvas.classList.toggle("is-on", this.gridMode === "photo" && this.underlayRecord !== null);
    // ツールバーのボタンには、いま選んでいる下敷きの絵を出す。
    const button = this.buttons.get("grid");
    button?.classList.toggle("is-active", this.gridMode !== "off");
    const icon = button?.querySelector(".icon");
    if (icon != null) icon.innerHTML = GRID_MODES[this.gridMode].iconSvg;
    for (const element of this.gridPanel.element.querySelectorAll<HTMLElement>(".grid-mode-row .nib-button")) {
      element.classList.toggle("is-active", element.dataset.grid === this.gridMode);
    }
    // gridMode が変わるたびに帯の表示・非表示も追従させる(ここが唯一の入口)。
    void this.refreshUnderlayStrip();
    this.syncUnderlayOpacityRow();
    this.syncUnderlayToggle();
  }

  // --- 写真の下敷き -------------------------------------------------------

  /**
   * 選ばれたファイルを下敷きへ取り込む。
   * 取り込み(デコード+縮小)は数MBの写真だと時間がかかるので、二重実行はガードする。
   */
  private async importUnderlayFile(file: File): Promise<void> {
    if (this.importingUnderlay) return;
    this.importingUnderlay = true;
    try {
      const record = await importUnderlay(file, Date.now(), this.canvasWidth, this.canvasHeight);
      await this.underlayStore.put(record);
      // 取り込みに成功した時点で、下敷きは最低1枚は必ずある。
      this.hasUnderlays = true;
      await this.applyUnderlay(record);
      // 上限を超えたぶんを黙って押し出す(画面には出さない。下敷きは取り込み直せるので知らせる必要がない)。
      // 今取り込んだものは createUnderlay() で lastUsedAt が now になっているので押し出されない
      // (=このプルーニングで hasUnderlays が false に戻ることはない)。
      await pruneUnderlays(this.underlayStore, MAX_UNDERLAYS);
      // 取り込みが成功して初めて写真モードへ入る(失敗時は元のモードのまま)。setGridMode の中で
      // 帯も作り直される(プルーニング後の一覧を反映させたいので、ここより前ではなく後で呼ぶ)。
      this.setGridMode("photo");
      // 取り込んだ直後はまだ位置が決まっていない(contain の中央寄せのまま)。
      // 位置を決めたいはずなので、自動で「置く」状態に入る。
      this.enterPlacingUnderlay();
      this.sound.play("poko");
    } catch (error) {
      const code = error instanceof UnderlayImportError ? error.code : null;
      const anchor = this.buttons.get("grid") ?? this.gridPanel.element;
      this.guide.show(underlayErrorMessage(code), anchor);
      if (!(error instanceof UnderlayImportError)) console.warn("したじきの取り込みに失敗しました", error);
    } finally {
      this.importingUnderlay = false;
    }
  }

  /** 下敷きレコードをデコードして描画状態に反映する。差し替え時は古いビットマップを閉じる。 */
  private async applyUnderlay(record: UnderlayRecord): Promise<void> {
    const bitmap = await createImageBitmap(record.image);
    this.underlayBitmap?.close();
    this.underlayBitmap = bitmap;
    this.underlayRecord = record;
    this.drawUnderlay();
  }

  /** underlayCanvas への実際の描画。placement はキャンバス座標系なのでそのまま渡せる。 */
  private drawUnderlay(): void {
    if (this.underlayCtx === null) return;
    this.underlayCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    if (this.underlayRecord === null || this.underlayBitmap === null) return;
    const { placement, opacity, width, height } = this.underlayRecord;
    // 濃さは canvas に描き込まず CSS の opacity で載せる(差し替えのたびに再エンコードしなくて済む)。
    this.underlayCanvas.style.opacity = String(UNDERLAY_ALPHA[opacity]);
    this.underlayCtx.drawImage(this.underlayBitmap, placement.tx, placement.ty, width * placement.scale, height * placement.scale);
    // 濃さ行の選択状態(is-active)は underlayRecord.opacity を見ているので、
    // 描き直すたびに揃えておく(選び直し・置く操作での更新も含めて、ここが唯一の入口)。
    this.syncUnderlayOpacityRow();
    // 置く操作中は underlayCanvas を隠し、代わりに全画面の placeCanvas へ描く(二重に描かない)。
    if (this.placingUnderlay) this.drawPlaceCanvas();
  }

  /**
   * 帯のサムネイルを押したときの選び直し。切り替えて描き直し、押し出しの基準になる
   * lastUsedAt を更新して保存する。メニューは閉じない(見比べて選べるように)。
   */
  private async selectUnderlay(record: UnderlayRecord): Promise<void> {
    const updated: UnderlayRecord = { ...record, lastUsedAt: Date.now() };
    // 選び直せている時点で下敷きは最低1枚ある。
    this.hasUnderlays = true;
    await this.underlayStore.put(updated);
    await this.applyUnderlay(updated);
    // 別の写真を選んだら、隠していても見えている状態から始める(持ち越さない)。
    this.underlayHiddenByUser = false;
    this.syncUnderlayToggle();
    this.persistProgress();
    this.sound.play("poko");
    void this.refreshUnderlayStrip();
  }

  /**
   * 帯の中身を作り直す。gridMode が "photo" のときだけ store から一覧を取り直し、
   * それ以外では空にして隠す(syncGridButtons から常に呼ばれる)。
   */
  private async refreshUnderlayStrip(): Promise<void> {
    const records = this.gridMode === "photo" ? await this.underlayStore.list() : [];
    this.renderUnderlayStrip(records);
    // 帯の行が増減してパネルの高さが変わるので、開いていれば位置を計算し直す。
    if (this.gridPanel.isOpen) {
      const anchor = this.buttons.get("grid");
      if (anchor !== undefined) this.gridPanel.open(anchor);
    }
  }

  /**
   * 帯の DOM を作り直す。
   * 並びは records の順(= store.list() の createdAt 新しい順)のまま使う。lastUsedAt 順にすると
   * 使うたびに並びが変わって探せなくなるため、並び順は取り込んだ順で固定する。
   *
   * 押すたびに帯全体を作り直すので、スクロール位置を保存しておいて作り直したあとに戻す
   * (しないと選ぶたびに帯が左端へ飛んで、右の方の写真を続けて選べなくなる)。
   */
  private renderUnderlayStrip(records: readonly UnderlayRecord[]): void {
    const previousScrollLeft = this.underlayStripTrack.scrollLeft;
    // 古い objectURL を握ったままにしない(写真ぶんメモリが積み上がる。gallery.ts と同じ作法)。
    for (const url of this.underlayThumbUrls) URL.revokeObjectURL(url);
    this.underlayThumbUrls = [];
    this.underlayStripTrack.textContent = "";
    this.underlayStrip.classList.toggle("is-visible", this.gridMode === "photo");
    if (this.gridMode !== "photo") {
      this.underlayStripScroll?.sync();
      return;
    }

    // 先頭に「＋」。何枚溜まってもスクロールせずに指が届く位置に置く。
    const add = document.createElement("button");
    add.className = "underlay-add";
    add.innerHTML = UNDERLAY_ADD_SVG;
    add.setAttribute("aria-label", "しゃしんをふやす");
    add.addEventListener("click", () => this.underlayInput.click());
    this.underlayStripTrack.appendChild(add);

    for (const record of records) {
      const button = document.createElement("button");
      button.className = "underlay-thumb";
      button.classList.toggle("is-active", record.id === this.underlayRecord?.id);
      button.setAttribute("aria-label", "したじきをえらぶ");
      const url = URL.createObjectURL(record.thumbnail);
      this.underlayThumbUrls.push(url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      button.appendChild(img);
      button.addEventListener("click", () => void this.selectUnderlay(record));
      this.underlayStripTrack.appendChild(button);
    }
    // 作り直した直後は scrollWidth が確定していないブラウザがあるため、次フレームで復元する。
    this.underlayStripTrack.scrollLeft = previousScrollLeft;
    this.underlayStripScroll?.sync();
    requestAnimationFrame(() => {
      this.underlayStripTrack.scrollLeft = previousScrollLeft;
      this.underlayStripScroll?.sync();
    });
  }

  /**
   * マスのパネルを開いたときの後始末。
   *  - 帯は開くまで display: none で幅 0 のため、閉じている間に届いた sync() は
   *    「送り先が無い」という誤った結果のまま残ってしまう。開いた直後に必ず計算し直す。
   *  - 選んでいる下敷きが帯の外(スクロールしないと見えない位置)にあれば、
   *    それが見える位置までスクロールする(12 枚あると隠れていることがあるため)。
   */
  private onGridPanelOpened(): void {
    this.underlayStripScroll?.sync();
    const active = this.underlayStripTrack.querySelector<HTMLElement>(".underlay-thumb.is-active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // --- 下敷きを「置く」(位置・大きさを指で決める) -------------------------

  /**
   * 「置く」状態に入る。画面全体(placeCanvas)でドラッグ・ピンチを拾って下敷きだけを動かし、
   * 代わりに描く・紙のピンチ・2本指タップ(戻る)を止める(installInput 側の分岐)。
   * 紙が見えないと位置を決められないので、マスのパネルは閉じる。
   *
   * 紙も 0.7 倍に縮めて画面中央へ寄せ、はみ出しを見せる余白を作る。この縮小は
   * viewport.ts の view(ピンチの状態)とは別系統。いまの view を覚えておき、いったん
   * 等倍へ戻してから縮小をかける(戻すときに view とちぐはぐにならないように)。
   */
  private enterPlacingUnderlay(): void {
    if (this.underlayRecord === null) return;
    this.placingUnderlay = true;
    this.placeDragId = null;
    this.placeLastPoint = null;
    this.gridPanel.close();
    this.savedView = this.view;
    this.applyView(IDENTITY);
    this.paperWrap.style.transformOrigin = "50% 50%";
    this.paperWrap.style.transform = `scale(${PLACE_PAPER_SCALE})`;
    this.syncPlacingUnderlay();
    this.drawPlaceCanvas();
    // 置く中は placeCanvas が紙より手前を覆うため、ホイールは紙まで届かない。
    // 同じ処理(handleWheel)を置く用の要素にも付け、抜けるときに後始末する。
    this.placeWheelAbort = new AbortController();
    this.placeCanvas.addEventListener("wheel", (event) => this.handleWheel(event), {
      passive: false,
      signal: this.placeWheelAbort.signal,
    });
  }

  /** 「これでいい」で抜ける。抜けたときの配置を保存し、紙の大きさと view を元に戻す。 */
  private exitPlacingUnderlay(): void {
    if (!this.placingUnderlay) return;
    this.placingUnderlay = false;
    this.placeDragId = null;
    this.placeLastPoint = null;
    this.placeWheelAbort?.abort();
    this.placeWheelAbort = null;
    if (this.underlayRecord !== null) void this.underlayStore.put(this.underlayRecord);
    this.paperWrap.style.transformOrigin = "";
    const restore = this.savedView ?? IDENTITY;
    this.savedView = null;
    this.applyView(restore);
    this.syncPlacingUnderlay();
  }

  /** 置く状態の見た目を揃える。紙側は隠し、代わりに全画面の placeCanvas を出す。 */
  private syncPlacingUnderlay(): void {
    this.underlayCanvas.classList.toggle("is-placing", this.placingUnderlay);
    this.placeCanvas.classList.toggle("is-visible", this.placingUnderlay);
    this.placeDoneButton?.classList.toggle("is-visible", this.placingUnderlay);
    this.syncUnderlayToggle();
  }

  /** 1本指ドラッグぶんキャンバス座標のまま tx/ty に足す。point は既にキャンバス座標。 */
  private moveUnderlayBy(dx: number, dy: number): void {
    if (this.underlayRecord === null) return;
    const { placement, width, height } = this.underlayRecord;
    const moved = clampPlacement(
      { scale: placement.scale, tx: placement.tx + dx, ty: placement.ty + dy },
      width,
      height,
      this.canvasWidth,
      this.canvasHeight,
    );
    this.underlayRecord = { ...this.underlayRecord, placement: moved };
    this.drawUnderlay();
  }

  /**
   * ピンチで下敷きを拡大縮小・平行移動する。
   * change の中点・移動量は画面座標(px)なので、紙の実寸(getBoundingClientRect)から
   * 画面px→キャンバスpxの比率を出して変換する(紙がピンチで拡大表示されていても狂わない)。
   */
  private applyUnderlayGesture(change: GestureChange): void {
    if (this.underlayRecord === null) return;
    const { placement, width, height } = this.underlayRecord;
    const rect = this.paperCanvas.getBoundingClientRect();
    const anchor = toCanvasPoint(change.centerX, change.centerY, rect, this.canvasWidth, this.canvasHeight);
    const ratioX = rect.width > 0 ? this.canvasWidth / rect.width : 1;
    const ratioY = rect.height > 0 ? this.canvasHeight / rect.height : 1;
    const scaled = scaleAt(
      placement,
      width,
      height,
      anchor.x,
      anchor.y,
      change.scaleFactor,
      this.canvasWidth,
      this.canvasHeight,
    );
    const moved = clampPlacement(
      { scale: scaled.scale, tx: scaled.tx + change.dx * ratioX, ty: scaled.ty + change.dy * ratioY },
      width,
      height,
      this.canvasWidth,
      this.canvasHeight,
    );
    this.underlayRecord = { ...this.underlayRecord, placement: moved };
    this.drawUnderlay();
  }

  /**
   * 置く操作中、画面全体(placeCanvas)で 1 本指ドラッグ・ピンチを拾う。
   * installPointerInput() は canvas.getBoundingClientRect() と canvas.width/height の比で
   * 画面座標→CanvasPoint を作る。placeCanvas は resizePlaceCanvas() で幅高さを自分の
   * 表示サイズちょうどに合わせているので、ここで受け取る point.x/y は
   * 「placeCanvas 左上からのローカル座標(≒スクリーン座標)」になる ── 紙の canvas 前提の
   * 変換ではない。紙のキャンバス座標(1748x1181)がほしいときは placeScreenToCanvas() で
   * 改めて紙の実寸(paperCanvas.getBoundingClientRect())から自前で変換する。
   * ピンチ(GestureChange)の dx/dy/centerX/centerY は pointerInput.ts 内部で常に生の
   * clientX/clientY から作られるため、どの canvas で拾っても値は変わらず、
   * applyUnderlayGesture() をそのまま使い回せる。
   */
  private installPlaceInput(): void {
    this.placeInput = installPointerInput(this.placeCanvas, {
      onDown: (id, point) => {
        if (!this.placingUnderlay || this.placeDragId !== null) return;
        this.placeDragId = id;
        this.placeLastPoint = this.placeScreenToCanvas(point.x, point.y);
      },
      onMove: (id, point) => {
        if (!this.placingUnderlay || id !== this.placeDragId || this.placeLastPoint === null) return;
        const next = this.placeScreenToCanvas(point.x, point.y);
        this.moveUnderlayBy(next.x - this.placeLastPoint.x, next.y - this.placeLastPoint.y);
        this.placeLastPoint = next;
      },
      onUp: (id) => {
        if (id !== this.placeDragId) return;
        this.placeDragId = null;
        this.placeLastPoint = null;
      },
      onGestureStart: () => {
        // 2本目が触れたらドラッグは終わり、ここからはピンチ(onGestureChange)へ切り替わる。
        this.placeDragId = null;
        this.placeLastPoint = null;
      },
      onGestureChange: (change) => {
        if (!this.placingUnderlay) return;
        this.applyUnderlayGesture(change);
      },
    });
  }

  /** placeCanvas 上のローカル座標(≒スクリーン座標)を、紙の実寸から紙のキャンバス座標へ直す。 */
  private placeScreenToCanvas(localX: number, localY: number): { x: number; y: number } {
    const placeRect = this.placeCanvas.getBoundingClientRect();
    const paperRect = this.paperCanvas.getBoundingClientRect();
    return toCanvasPoint(placeRect.left + localX, placeRect.top + localY, paperRect, this.canvasWidth, this.canvasHeight);
  }

  /** placeCanvas の実ピクセル数を、いまの表示サイズちょうどに合わせる(画面座標=キャンバス値にするため)。 */
  private resizePlaceCanvas(): void {
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (this.placeCanvas.width !== width) this.placeCanvas.width = width;
    if (this.placeCanvas.height !== height) this.placeCanvas.height = height;
  }

  /**
   * 置く操作中の全画面描画。写真の全体を画面座標で描き、紙の中に入る部分は今までどおりの濃さ、
   * 紙の外にはみ出す部分はさらに薄く(UNDERLAY_OUTSIDE_ALPHA_FACTOR 掛け)描く。
   * 紙の内と外は clip() で塗り分ける(同じ画像を 2 回描くだけで済む簡単な実装)。
   */
  private drawPlaceCanvas(): void {
    if (this.placeCtx === null || this.underlayRecord === null || this.underlayBitmap === null) return;
    this.resizePlaceCanvas();
    const ctx = this.placeCtx;
    const { placement, opacity, width, height } = this.underlayRecord;
    const paperRect = this.paperCanvas.getBoundingClientRect();
    const placeRect = this.placeCanvas.getBoundingClientRect();
    // 紙の矩形を placeCanvas のローカル座標へ。
    const paperLeft = paperRect.left - placeRect.left;
    const paperTop = paperRect.top - placeRect.top;
    const ratioX = this.canvasWidth > 0 ? paperRect.width / this.canvasWidth : 1;
    const ratioY = this.canvasHeight > 0 ? paperRect.height / this.canvasHeight : 1;
    const imgLeft = paperLeft + placement.tx * ratioX;
    const imgTop = paperTop + placement.ty * ratioY;
    const imgWidth = width * placement.scale * ratioX;
    const imgHeight = height * placement.scale * ratioY;

    ctx.clearRect(0, 0, this.placeCanvas.width, this.placeCanvas.height);

    // まず画面全体へ薄く(紙の外へはみ出した部分はここだけが見える)。
    ctx.save();
    ctx.globalAlpha = UNDERLAY_ALPHA[opacity] * UNDERLAY_OUTSIDE_ALPHA_FACTOR;
    ctx.drawImage(this.underlayBitmap, imgLeft, imgTop, imgWidth, imgHeight);
    ctx.restore();

    // 紙の内側だけ、今までどおりの濃さで重ね描き。
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(paperLeft, paperTop, paperRect.width, paperRect.height, PAPER_CORNER_RADIUS);
    ctx.clip();
    ctx.globalAlpha = UNDERLAY_ALPHA[opacity];
    ctx.drawImage(this.underlayBitmap, imgLeft, imgTop, imgWidth, imgHeight);
    ctx.restore();
  }

  /**
   * 起動時に hasUnderlays を揃える。gridMode が "photo" かどうかに関わらず、
   * 端末に取り込み済みの下敷きが残っているかどうかだけを見る(写真ボタンの
   * クリック処理が await なしで参照するためのフラグなので、gridMode の分岐とは独立)。
   */
  private async refreshHasUnderlays(): Promise<void> {
    try {
      this.hasUnderlays = (await this.underlayStore.list()).length > 0;
    } catch (error) {
      console.warn("したじきの一覧取得に失敗しました", error);
    }
  }

  /**
   * 起動時の復元。gridMode が "photo" のときだけ underlayStore から読み直す。
   * レコードが見つからなくても起動自体は失敗させず、静かに "off" へ落とす。
   */
  private async restoreUnderlay(): Promise<void> {
    if (this.gridMode !== "photo") return;
    try {
      const record = this.underlayId === null ? null : await this.underlayStore.get(this.underlayId);
      if (record === null) {
        this.gridMode = "off";
        this.persistProgress();
      } else {
        await this.applyUnderlay(record);
      }
    } catch (error) {
      console.warn("したじきの復元に失敗しました", error);
      this.gridMode = "off";
      this.persistProgress();
    }
    this.syncGridButtons();
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
        this.fillPanel.close();

        // 置く操作中は紙に描かない。ドラッグ・ピンチは画面全体を覆う placeCanvas 側
        // (installPlaceInput)が拾うので、ここでは何もしない。
        if (this.placingUnderlay) return;

        if (this.activeTool === "picker") {
          // スポイトの道具で吸ったときは「吸ったら描ける」まで含めて 1 動作にする。
          if (this.pickColorAt(point.x, point.y)) this.setActiveTool("pen");
          return;
        }

        if (this.activeTool === "fill") {
          if (isShapeMode(this.fillMode)) {
            // なぞって範囲を決める。指を離すまでは仮の層に下見を出すだけで、絵は変えない。
            this.shapeDrag = { id, mode: this.fillMode, x: point.x, y: point.y, endX: point.x, endY: point.y };
            this.surface.previewShape(
              this.fillMode,
              point.x,
              point.y,
              point.x,
              point.y,
              this.color,
              this.cellGrid,
            );
            return;
          }
          // ビーズは円で置くので画素をたどる塗りつぶしだと背景へ漏れる。マス単位で広げる。
          const cellGrid = this.cellGrid;
          const rect = cellGrid !== null
            ? this.surface.fillCells(cellGrid, point.x, point.y, this.color)
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
            ...(this.cellGrid === null ? {} : { cells: this.cellGrid }),
          },
          point.time,
          point.pressure,
        );
      },
      onMove: (id, point) => {
        if (this.placingUnderlay) return;
        const drag = this.shapeDrag;
        if (drag !== null) {
          if (drag.id !== id) return;
          drag.endX = point.x;
          drag.endY = point.y;
          this.surface.previewShape(drag.mode, drag.x, drag.y, point.x, point.y, this.color, this.cellGrid);
          return;
        }
        if (!this.lastPoints.has(id)) return;
        this.lastPoints.set(id, point);
        this.surface.extendStroke(id, point.x, point.y, point.time, point.pressure);
      },
      onGestureStart: (id) => {
        if (this.placingUnderlay) return;
        // ピンチに移った瞬間、なぞりかけの形も捨てる(線と同じ扱い)。
        this.shapeDrag = null;
        this.surface.clearShapePreview();
        // ピンチに移った瞬間、描きかけの線を捨てる(写真アプリの感覚で触った子を裏切らない)。
        if (id !== undefined) this.lastPoints.delete(id);
        this.surface.cancelStroke(id);
      },
      onGestureChange: (change) => {
        // 置く操作中の紙のピンチ(見る操作)は止める。下敷き専用のピンチは
        // placeCanvas 側(installPlaceInput)が拾うので、ここでは何もしない。
        if (this.placingUnderlay) return;
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
        if (this.placingUnderlay) return;
        this.scheduleSave();
      },
      onPick: (point) => {
        if (this.placingUnderlay) return;
        // 右クリックは色を吸うだけ。道具は切り替えない
        // (描いている途中に色だけ変えたい、という使い方のため)。
        this.pickColorAt(point.x, point.y);
      },
      onTwoFingerTap: () => {
        // 置く操作中に履歴が動くと混乱するので止める。
        if (this.placingUnderlay) return;
        // 2 本指タップ = もどる。ツールバーまで指を運ばずに失敗を消せる。
        if (this.surface.undo()) {
          this.sound.play("shu");
          this.afterHistoryChange();
        }
      },
      onUp: (id) => {
        if (this.placingUnderlay) return;
        const drag = this.shapeDrag;
        if (drag !== null) {
          if (drag.id !== id) return;
          this.shapeDrag = null;
          const rect = this.surface.fillShape(
            drag.mode,
            drag.x,
            drag.y,
            drag.endX,
            drag.endY,
            this.color,
            this.cellGrid,
          );
          if (rect !== null) {
            this.surface.commit(rect);
            this.sound.play("shu");
            this.countStroke();
            this.afterHistoryChange();
          }
          return;
        }
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
    // 「画面」= 拡大した紙を切り取る枠(.stage、overflow: hidden)の矩形。
    // window.innerWidth/innerHeight を使うとヘッダー/ツールバー分だけ実際の
    // 描画領域より大きくなり、隙間が見えてしまう(.stage はヘッダーの下・
    // ツールバーの上に収まる領域なので、window 全体とは一致しない)。
    this.view = clampView(next, this.layoutRect(), this.stageRect());
    this.paperWrap.style.transform = toCss(this.view);
    // 紙が全部見えていないときだけ「ぜんぶ見る」を出す(スマホでは常に出る)。
    this.fitButton?.classList.toggle("is-visible", this.view.scale > 1.02);
    // 起動直後の1回目(まだ「動かした」わけではない)は全体図の対象にしない。
    if (this.minimapArmed) this.updateMinimap();
  }

  /**
   * 全体図(ミニマップ)を更新する。紙の位置/大きさが変わるたびに呼ばれる想定。
   * - 紙が全部見えている状態になったら、示すことが無いので即座に隠す(出ている途中でも消す)。
   * - 出た瞬間(隠れている→見せる)だけ絵を描き直す(毎フレーム描き直さない)。
   * - 「見えている範囲」の枠は毎回動かす。
   * - 動きが止まってから 2 秒でフェードアウトする(タイマーは動くたびに延びる)。
   * 紙が全部見えている状態が続く(=タブレットでの既定)場合は動きが起きないので、
   * 結果として全体図も出ない。
   */
  private updateMinimap(): void {
    if (isFullyVisible(visibleRect(this.view, this.layoutRect(), this.stageRect()))) {
      if (this.minimapHideTimer !== null) {
        window.clearTimeout(this.minimapHideTimer);
        this.minimapHideTimer = null;
      }
      this.minimapVisible = false;
      this.minimap.classList.remove("is-visible");
      return;
    }
    if (!this.minimapVisible) {
      this.minimapVisible = true;
      this.minimap.classList.add("is-visible");
      this.drawMinimapThumbnail();
    }
    this.positionMinimapViewportBox();
    if (this.minimapHideTimer !== null) window.clearTimeout(this.minimapHideTimer);
    this.minimapHideTimer = window.setTimeout(() => {
      this.minimapVisible = false;
      this.minimap.classList.remove("is-visible");
      this.minimapHideTimer = null;
    }, 2000);
  }

  /** いまの絵(紙のキャンバスの中身)を全体図に縮小して描く。drawImage 1回だけ。 */
  private drawMinimapThumbnail(): void {
    if (this.minimapCtx === null) return;
    const ctx = this.minimapCtx;
    const { width, height } = this.minimapCanvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fffdf7";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(this.paperCanvas, 0, 0, width, height);
  }

  /** 「いま画面に見えている範囲」の枠を、紙全体を表す全体図の中の割合の位置へ動かす。 */
  private positionMinimapViewportBox(): void {
    const rect = visibleRect(this.view, this.layoutRect(), this.stageRect());
    const box = this.minimapViewportBox;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
  }

  /** 「画面(描画領域)」= 紙を切り取る枠(.stage)の、今の矩形。 */
  private stageRect(): Rect {
    return this.stage.getBoundingClientRect();
  }

  /**
   * 画面の短い辺が PHONE_SHORT_SIDE_MAX 未満ならスマホ扱い。
   * タブレット/PCは今までどおり紙が全部見える(倍率1)状態を保つ。
   */
  private isPhoneScreen(stage: Rect): boolean {
    return Math.min(stage.width, stage.height) < PHONE_SHORT_SIDE_MAX;
  }

  /**
   * 最初の倍率。スマホは紙が画面(描画領域)を覆う倍率(縦横それぞれの比の大きい方)、
   * タブレット/PCは今までどおり1(全体表示)。
   */
  private initialScale(stage: Rect, layout: Rect): number {
    if (!this.isPhoneScreen(stage)) return MIN_SCALE;
    if (layout.width <= 0 || layout.height <= 0) return MIN_SCALE;
    return Math.max(stage.width / layout.width, stage.height / layout.height);
  }

  /**
   * 画面(スマホ/タブレット)に合わせた最初の見え方を適用する。起動時・作品を開いた/
   * 新しく描き始めた直後・画面の回転やリサイズのたびに呼ぶ。紙の自然な中心(layoutの
   * 中心、今までどおり画面の中央にある)を固定してズームするので、タブレットでは
   * 今までどおり中央のまま、スマホでは中央から画面いっぱいまで広がる。
   */
  private applyInitialView(): void {
    const stage = this.stageRect();
    const layout = this.layoutRect();
    const anchorX = layout.left + layout.width / 2;
    const anchorY = layout.top + layout.height / 2;
    this.applyView(zoomAt(IDENTITY, layout, anchorX, anchorY, this.initialScale(stage, layout)));
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
    canvas.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
  }

  /**
   * ホイール処理の本体。紙(canvas)と、置く操作中の全画面 placeCanvas の両方から呼ぶ
   * (紙は覆われて手前の placeCanvas にイベントが止まってしまうため)。
   * 処理そのものは 1 つに保ち、どちらの要素でリスナーを張るかだけを分ける。
   */
  private handleWheel(event: WheelEvent): void {
    event.preventDefault();
    if (this.multiDraw) return;
    // 置く操作中は、紙と同じホイールの約束(ホイール=移動 / Ctrl(⌘)+ホイール=拡大)を
    // 紙ではなく下敷きへ向け直す。紙自体はここで止め、動かさない(置く中の性質を壊さない)。
    if (this.placingUnderlay) {
      const factor = event.ctrlKey || event.metaKey ? Math.exp(-event.deltaY * 0.002) : 1;
      const dx = event.ctrlKey || event.metaKey ? 0 : event.shiftKey ? -event.deltaY : -event.deltaX;
      const dy = event.ctrlKey || event.metaKey ? 0 : event.shiftKey ? 0 : -event.deltaY;
      this.applyUnderlayGesture({ scaleFactor: factor, dx, dy, centerX: event.clientX, centerY: event.clientY });
      return;
    }
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
  }

  private afterHistoryChange(): void {
    this.syncHistoryButtons();
    this.scheduleSave();
  }

  /** 戻る/進むが効かない時は、押せない状態にした上で薄く見せる。 */
  private syncHistoryButtons(): void {
    // みんなで描くモードでは戻る/進むを持たない。押せないことが見て・触って分かるようにする。
    this.setHistoryButtonEnabled("undo", !this.multiDraw && this.surface.canUndo);
    this.setHistoryButtonEnabled("redo", !this.multiDraw && this.surface.canRedo);
  }

  /** ボタン要素は素の <button> なので、disabled 属性そのものを使って押せなくする。 */
  private setHistoryButtonEnabled(id: "undo" | "redo", enabled: boolean): void {
    const button = this.buttons.get(id);
    if (button === undefined) return;
    button.classList.toggle("is-dim", !enabled);
    if (button instanceof HTMLButtonElement) button.disabled = !enabled;
  }

  /** 選択中の色をツールバーのボタンに反映する。 */
  private syncColorChip(): void {
    const chip = this.buttons.get("color")?.querySelector<HTMLElement>(".color-chip");
    if (chip !== undefined && chip !== null) chip.style.background = this.color;
  }

  /** その場所の色を吸う。吸えたら true。 */
  private pickColorAt(x: number, y: number): boolean {
    // ビーズはマスの輪を見る。中心は穴(透明)なので紙の色を吸ってしまう。
    const pickGrid = this.cellGrid;
    const picked = pickGrid !== null ? this.surface.pickCell(pickGrid, x, y) : this.surface.pick(x, y);
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
      underlayId: this.underlayRecord?.id ?? null,
      nib: this.nib,
      multiDraw: this.multiDraw,
      screenFilter: this.screenFilter,
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
      this.applyWorkPaper();
      // 作品を切り替えたので、スマホ/タブレットに合わせた最初の見え方からやり直す。
      this.applyInitialView();
    }
    await this.captureSnapshot("revert");
    // 履歴画像は work と同じ寸法で焼かれているので、work の寸法に揃えてから描き戻す。
    this.applyCanvasSize(work.canvasWidth, work.canvasHeight);
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
    // 開く作品の寸法に合わせてから描き戻す(いまは全作品 1748x1181 なので実質は保険)。
    this.applyCanvasSize(work.canvasWidth, work.canvasHeight);
    await this.surface.restoreFrom(image);
    this.work = work;
    this.applyWorkPaper();
    // 開いた作品はスマホ/タブレットに合わせた最初の見え方から始める。
    this.applyInitialView();
    this.lastSnapshotAt = work.updatedAt;
    // ひらいた瞬間の姿を残す。この 1 枚が上書き事故の保険になる。
    await this.captureSnapshot("open");
    this.persistProgress();
    this.syncHistoryButtons();
    this.sound.play("poko");
    this.gallery.close();
  }

  /** ギャラリーの「はがき よこ/たて」ボタンから、選んだ向きの寸法で新しい作品を作る。 */
  private async createWork(sizeId: CanvasSizeId = "postcard-landscape"): Promise<void> {
    await this.save();
    const size = CANVAS_SIZES[sizeId];
    this.applyCanvasSize(size.width, size.height);
    this.surface.reset();
    // 空の作品をこの場で作って開いた状態にする。
    // 「あたらしく かく」を押した時点で一覧に 1 枚増えていないと、描く前に閉じた子の絵が迷子になる。
    this.work = createWork(
      await this.surface.toPng(),
      Date.now(),
      await this.surface.toThumbnail(),
      size.width,
      size.height,
    );
    this.applyWorkPaper();
    // 新しく描き始めた作品もスマホ/タブレットに合わせた最初の見え方から始める。
    this.applyInitialView();
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
        // ここは「捨てたら1枚も残らなかった」ときの穴埋めなので、向きを選ばせず既定寸法(横)にする。
        this.applyCanvasSize(CANVAS_WIDTH, CANVAS_HEIGHT);
        this.surface.reset();
        this.work = createWork(await this.surface.toPng(), Date.now(), await this.surface.toThumbnail());
        await this.store.put(this.work);
      } else {
        this.applyCanvasSize(next.canvasWidth, next.canvasHeight);
        const image = next.pages[0]?.image;
        if (image !== undefined) await this.surface.restoreFrom(image);
        this.work = next;
      }
      this.applyWorkPaper();
      this.applyInitialView();
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
        pages: [{ id: page?.id ?? "page-0", image: png, deleted: page?.deleted ?? false }],
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
      this.applyCanvasSize(latest.canvasWidth, latest.canvasHeight);
      await this.surface.restoreFrom(image);
      this.work = latest;
      this.applyWorkPaper();
      // 起動直後にもう一度、スマホ/タブレットに合わせた最初の見え方を揃える
      // (コンストラクタ側の1回目は絵の読み込み前で、大きさが変わっていないので実質は保険)。
      this.applyInitialView();
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
    // 書き出し用は保存データと違い、紙の質感を焼き込む(surface.ts の toExportPng 参照)。
    const png = await this.surface.toExportPng(this.getPaperTexture(this.paperKind));
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

/**
 * 下敷きの取り込み失敗を子ども向けの短い文言にする。
 * core 側(underlayImport.ts)は code しか持たないので、文言を決めるのはこの UI 層の責任。
 */
function underlayErrorMessage(code: UnderlayImportErrorCode | null): string {
  switch (code) {
    case "unsupportedType":
      return "これは ひらけません";
    case "tooLarge":
      return "おおきすぎます";
    case "decodeFailed":
    case "encodeFailed":
      return "よみこめませんでした";
    default:
      return "よみこめませんでした";
  }
}

const version = document.getElementById("app-version");
// git commit 由来の版文字列がビルド時に差し込まれる(vite.config.ts の define)。
if (version !== null) version.textContent = __APP_VERSION__;

const root = document.getElementById("app");
if (root !== null) new App(root);
