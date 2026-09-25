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
import { patternTile, PATTERNS, PATTERN_ORDER, type PatternId } from "./core/pattern.ts";
import { createPaperTexture, PAPER_KINDS, PAPER_KIND_ORDER, type PaperKind } from "./core/paper.ts";
import {
  appendSnapshot,
  CANVAS_HEIGHT,
  CANVAS_SIZES,
  CANVAS_WIDTH,
  createId,
  createWork,
  currentPageOf,
  FRAME_LIMIT,
  snapshotOf,
  type CanvasSizeId,
  type CellGrid,
  type PageData,
  type SnapshotReason,
  type WorkRecord,
} from "./core/model.ts";
import { createWorkStore, requestPersistentStorage } from "./core/workStore.ts";
import {
  drawFrame,
  FRAME_PRESET_ORDER,
  FRAME_PRESETS,
  framePresetOf,
  type FrameData,
  type FramePresetId,
} from "./core/frame.ts";
import { clampPlacement, scaleAt, UNDERLAY_ALPHA, MAX_UNDERLAYS, type UnderlayOpacity, type UnderlayRecord } from "./core/underlay.ts";
import { importUnderlay, UnderlayImportError, type UnderlayImportErrorCode } from "./core/underlayImport.ts";
import { createUnderlayStore, pruneUnderlays, type UnderlayStore } from "./core/underlayStore.ts";
import { hexToRgba, SOFT_LAYER_LIMIT, Surface, thumbnailFromImage } from "./core/surface.ts";
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
import { LayerStrip, type LayerStripItem } from "./ui/layerStrip.ts";
import { RemoveLayerConfirm } from "./ui/removeLayerConfirm.ts";
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
  ONION_SVG,
  PLAY_SVG,
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

/**
 * 「うすく」で前のコマを重ねる濃さ(onionCanvas の opacity)。docs/animation.md の決めたこと
 * どおり濃さは固定。0.3 程度にしているのは、乗算(multiply)なので既にこの上に紙色の分だけ
 * 暗くなる効果が乗る一方、今のコマの線と紛れて見分けが付かなくなるほど濃くはしたくない
 * ためのバランス(実データの画素で確認、2026-09-11)。
 */
const ONION_OPACITY = 0.3;

/** 「見る」で再生する速さ(docs/animation.md「見る」: 1秒に6コマ、固定)。 */
const FLIPBOOK_FPS = 6;
/** 1コマぶんの表示時間(ミリ秒)。FLIPBOOK_FPS から機械的に求める。 */
const FLIPBOOK_FRAME_MS = 1000 / FLIPBOOK_FPS;

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
   * 「うすく」(前のコマ)を描く専用キャンバス。underlayCanvas と同じく紙のキャンバスには
   * 一切描かない(作品の保存データにも PNG 書き出しにも入らない、表示だけの層)。
   * 置き場所の理由は buildStage(paperWrap.insertBefore 周り)のコメント参照。
   */
  private readonly onionCanvas: HTMLCanvasElement;
  private readonly onionCtx: CanvasRenderingContext2D | null;
  /**
   * 「見る」(パラパラ再生)専用キャンバス。onionCanvas と同じく紙のキャンバスには一切描かない。
   * 置き場所の理由・重なり順は buildStage(paperWrap.insertBefore 周り)のコメント参照。
   */
  private readonly playbackCanvas: HTMLCanvasElement;
  private readonly playbackCtx: CanvasRenderingContext2D | null;
  /**
   * マンガの「わく」(コマ割り。docs/manga.md)を描く専用キャンバス。パラパラの「コマ」とは
   * 別物(呼び名がかぶるので注意): こちらは 1 ページの中を割る枠線。
   * onionCanvas と同じく紙のキャンバスには一切描かないが、Surface.setOverprint() で
   * 「合成に重ねる 1 枚」としても渡すので、画面に見せる canvas そのものが保存・書き出し・
   * ぬりつぶしの境界判定にも使われる(syncFrameLayer() 参照。別々に描くとずれるため)。
   */
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly frameCtx: CanvasRenderingContext2D | null;
  /** いま frameCanvas に描いているわく。無ければ undefined(わく無し)。 */
  private currentFrame: FrameData | undefined;
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
  /** 「マス」パネルの一番下に出す、わく(コマ割り)のお手本を選ぶ行(docs/manga.md)。 */
  private frameRow!: HTMLElement;
  /** 「塗る」パネルの 2 行目、もよう(トーン)を選ぶ行(docs/manga.md)。 */
  private patternRow!: HTMLElement;
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
  /**
   * 最後に保存してからキャンバスの中身が変わったか。scheduleSave() が唯一の立て役。
   * false の save() は何もしない(同じ絵の版を増やさないため。docs/page-versions.md)。
   */
  private dirty = false;
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
   * かさね(レイヤー)の帯。「かさね」ボタンで出し入れするトグル(パネルとは違う経路)。
   * 表示のON/OFFはここで持ち、中身(一覧・札の絵)は syncLayerStrip() が Surface から作る。
   */
  private layerStrip!: LayerStrip;
  private layerStripVisible = false;
  private removeLayerConfirm!: RemoveLayerConfirm;
  /**
   * コマの帯(docs/animation.md 手順4a)。かさねの帯と同じ LayerStrip を、コマ向けの
   * options(order:"top-down" 等)で別インスタンスとして使う。パラパラ中の作品だけが持ち、
   * かさねの帯とは同時に出さない(1 コマ 1 枚の約束、syncFlipbookButtons が「かさね」
   * ボタン自体を休ませているのと同じ理由)。
   */
  private frameStrip!: LayerStrip;
  private frameStripVisible = false;
  /** コマの帯の切り替え・追加が二重に走らないようにするガード(連打・非同期処理中の再入防止)。 */
  private frameBusy = false;
  /**
   * 「今のコマ以外」の札の絵のキャッシュ。versionId をキーにする(中身が変わったら必ず
   * 別 versionId になる規則、docs/page-versions.md)ので、キーが同じなら描き直さなくてよい。
   *
   * 持つのは原寸の ImageBitmap ではなく、札の大きさ(layerThumbnailSize())へ一度だけ
   * 縮めた小さい canvas。原寸は 1748x1181 の PNG で 1 枚あたり約8MB あり、コマは24まで
   * 増えるので、原寸のまま全コマぶん持つと約200MBになり iPhone/古い iPad の Safari では
   * タブごと落ちかねない(実測ではなく寸法からの見積もり)。縮めたら原寸はすぐ close() して
   * 手放す(drawFramePageThumbnail 参照)。作品が切り替わったら(applyWorkPaper())
   * 中身をすべて捨てる(古い作品の画像を握ったままにしない)。
   */
  private readonly frameThumbCache = new Map<string, HTMLCanvasElement>();
  /**
   * frameThumbCache の中身を作ったときの layerThumbnailSize()。devicePixelRatio の変化等で
   * 途中でサイズが変わると、キャッシュ済みの小さい canvas がもう的の大きさに合わないので、
   * drawFramePageThumbnail が呼ばれるたびに今のサイズと比べ、違っていたら丸ごと作り直す。
   */
  private frameThumbCacheSize: { width: number; height: number } | null = null;
  /**
   * 「うすく」用、前のコマ1つぶんの原寸 ImageBitmap(1748x1181、約8MB)。
   * 札の絵は縮めた小さい canvas で足りるが、うすくは今の紙とそのまま重ねるので原寸が要る。
   * 「直前の1コマ」しか要らないため、versionId が変わったら古い方を close() してから
   * 入れ替える(frameThumbCache のように何枚も溜めない)。
   */
  private onionBitmapCache: { versionId: string; bitmap: ImageBitmap } | null = null;
  /**
   * パラパラを始める前、かさねが 2 枚以上あるときだけ出す「まとめるよ」の確かめ。
   * removeLayerConfirm と見た目・閉じ方は同じだが、消すかさねの id ではなく
   * 「まとめてよいか」を聞くだけなので、確認先は別インスタンスにする。
   */
  private flattenLayersConfirm!: RemoveLayerConfirm;
  /** コマを消す確かめ(手順4b)。文言は既定(「けしますか？」)のまま、対象だけコマの id にする。 */
  private removeFrameConfirm!: RemoveLayerConfirm;

  /**
   * パラパラの作品を開いている間だけ出す、右側の縦並びボタンの入れ物(手順5「うすく」・
   * 手順6「見る」を並べる予定)。右上の stage-toggles(音/全画面/かくす/フィルタ/ぜんぶ見る)
   * とは別の入れ物にして、その下に重ならないよう並べる。
   */
  private flipbookControls!: HTMLElement;
  private onionButton: HTMLElement | null = null;
  /** 「うすく」の ON/OFF。docs/animation.md どおり既定 ON、状態は保存しない(起動すると必ず ON)。 */
  private onionEnabled = true;
  /**
   * updateOnionLayer() の非同期読み込み(createImageBitmap)が終わる前にコマ・作品が
   * 切り替わったら、古い結果で描かないための世代カウンタ。呼ぶたびに +1 し、
   * await の後で値がずれていたら(=もっと新しい呼び出しが割り込んだら)描かずに捨てる。
   */
  private onionGeneration = 0;

  /** 「見る」ボタン。押すたびに再生の開始/停止をトグルする。 */
  private playbackButton: HTMLElement | null = null;
  /** 再生中かどうか。docs/animation.md「見る」: 紙・もう一度押す・他の操作のどれでも止まる。 */
  private playing = false;
  /**
   * 再生対象のコマの合成済み PNG(PageData.image)を、消えていないコマの並び順のまま
   * 控えたもの。startPlayback() が save() 直後の pages から一度だけ作り、止めたら空にする。
   * 原寸ビットマップ(1枚約8MB)ではなく Blob のまま持つ(まだデコードしていない=軽い)。
   */
  private playbackFrames: Blob[] = [];
  /** 今表示しているコマの、playbackFrames 内での添字。 */
  private playbackIndex = 0;
  /**
   * 読み終えた ImageBitmap を添字ごとに持つ(「今表示しているコマ」と「この先2コマ」の
   * 最大3枚だけ。docs/animation.md「少しずつ読む」)。表示に要らなくなったら必ず close() して
   * 手放す(1枚約8MB、全部持つと24コマで約200MBになり Safari が落ちる)。
   */
  private readonly playbackBitmaps = new Map<number, ImageBitmap>();
  /** 今 createImageBitmap() を呼んでいる最中の添字(同じコマを二重に読みに行かない)。 */
  private readonly playbackLoading = new Set<number>();
  /**
   * stopPlayback() のたびに +1 する世代カウンタ。非同期の読み込み(createImageBitmap)が
   * 終わる前に止められたら、読み終えたビットマップをすぐ close() して捨てる
   * (updateOnionLayer の onionGeneration と同じ考え方)。
   */
  private playbackGeneration = 0;
  /** requestAnimationFrame の id。stopPlayback() で必ず cancel する。 */
  private playbackRaf: number | null = null;
  /** 次のコマへ進んでよい時刻(performance.now() と同じ時間軸)。 */
  private playbackNextDueAt = 0;

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
   * 「塗る」の中身のもよう(トーン、docs/manga.md)。既定は solid(もようなし=今までどおりの
   * べた塗り)。保存はしない(起動時は常に "もようなし" から始まる)。
   */
  private fillPattern: PatternId = "solid";

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
    // 「うすく」の前のコマ。underlayCanvas と同じく placement 座標系を持たないので、
    // 実ピクセルは素直に canvasWidth x canvasHeight にして CSS で紙いっぱいへ伸ばす。
    this.onionCanvas = document.createElement("canvas");
    this.onionCanvas.className = "onion-layer";
    this.onionCanvas.width = this.canvasWidth;
    this.onionCanvas.height = this.canvasHeight;
    this.onionCtx = this.onionCanvas.getContext("2d");
    // 濃さは固定(ONION_OPACITY)。乗算(mix-blend-mode: multiply)は style.css 側で常に掛ける
    // (docs/animation.md「うすく」: 一番下のかさねは紙の色で不透明なので、そのまま半透明で
    // 重ねると今のコマの線まで紙色に覆われて褪せる。乗算なら紙のほぼ白い色は影響せず、
    // 前のコマの線だけが薄く乗る)。
    this.onionCanvas.style.opacity = String(ONION_OPACITY);
    // 「見る」の再生専用。onionCanvas と同じく placement 座標系を持たないので、
    // 実ピクセルは canvasWidth x canvasHeight にして CSS で紙いっぱいへ伸ばす。
    this.playbackCanvas = document.createElement("canvas");
    this.playbackCanvas.className = "playback-layer";
    this.playbackCanvas.width = this.canvasWidth;
    this.playbackCanvas.height = this.canvasHeight;
    this.playbackCtx = this.playbackCanvas.getContext("2d");
    // 再生中だけ pointer-events を有効にする(style.css の .playback-layer.is-on)ので、
    // 紙(canvas.paper)より手前でタップを受け止められる。押されたら止める。
    this.playbackCanvas.addEventListener("pointerdown", () => this.stopPlayback());
    // マンガの「わく」(docs/manga.md)。onionCanvas 等と同じく実ピクセルは
    // canvasWidth x canvasHeight にして CSS で紙いっぱいへ伸ばす。DOM 上の置き場所は
    // 組み立ての最後(仮インク(overlay)を挿した直後)で決める(insertBefore 周りのコメント参照)。
    this.frameCanvas = document.createElement("canvas");
    this.frameCanvas.className = "frame-layer";
    this.frameCanvas.width = this.canvasWidth;
    this.frameCanvas.height = this.canvasHeight;
    this.frameCtx = this.frameCanvas.getContext("2d");
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
    // 「見る」の再生 canvas。docs/animation.md「見る」のとおり canvas.paper の直後
    // (描いた線より上)・紙テクスチャより下に置く(質感は乗算で上から効くので、再生中も
    // 紙の見た目が変わらない)。再生中は描けない(pointer-events で紙より手前に立つ)ので、
    // 仮インク(overlay)より前でも後でも見た目に影響しない。
    this.paperWrap.insertBefore(this.playbackCanvas, this.surface.overlay);
    // わく(frameCanvas)は仮インク(overlay)の直後、つまり全部のかさねより上に置く。
    // Surface.restack() は上のかさねを overlay の "直前" に差し込むので、overlay の
    // 後ろに置けば常にかさねより上へ来る(z-index は付けない。DOM 順で重ねる原則のまま)。
    this.paperWrap.insertBefore(this.frameCanvas, this.surface.overlay.nextSibling);
    // 重なり順: 紙 → 見る(再生) → 仮インク(overlay) → わく → 紙テクスチャ → 下敷き写真 → うすく(前のコマ) → 方眼。
    // 方眼はマス目の目安なので常に一番上に見えていてほしい。紙の質感は絵そのものの一部と
    // いう位置づけで下敷き(写真)より下、仮インクより上に置く。
    // うすく(onionCanvas)は「今のコマの上に乗算で重ねる」ものなので、紙(paper)・仮インク
    // (overlay)より必ず上に無ければ乗算が効かない。写真の下敷き(underlayCanvas)より上に
    // したのは、写真とパラパラはどちらも稀にしか同時に使われないが、うすくは「今描いている
    // 線」と見比べる機能なので、参考素材である写真よりも絵そのものに近い側(方眼のすぐ下)に
    // 置いた方が自然なため。方眼(マス目の目安線)は常に一番上のまま変えない。
    this.paperWrap.insertBefore(this.paperTextureCanvas, this.gridLayer);
    this.paperWrap.insertBefore(this.underlayCanvas, this.gridLayer);
    this.paperWrap.insertBefore(this.onionCanvas, this.gridLayer);
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
    this.buildLayerStrip();
    this.renderToolbar();
    this.buildSoundToggle();
    this.buildFullscreenToggle();
    this.buildUnderlayToggle();
    this.buildScreenFilterToggle();
    this.buildFlipbookControls();
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
    // 画面が裏に回ったら再生を止める(裏で requestAnimationFrame を回し続けない。
    // docs/animation.md「見る」の止まる経路の1つ)。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.stopPlayback();
    });
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

    // overlay だけ外しても、レイヤーの控え canvas(display:none で見えないが 1 枚 8MB)が
    // .paper-wrap に残り続けて作り直すたびに積み上がるので、Surface 側にまとめて外させる。
    this.surface.detach();
    this.surface = new Surface(this.paperCanvas, width, height);
    // 重なり順は組み立て時と同じ: 紙 → 仮インク(overlay) → わく → 紙テクスチャ → 下敷き写真 → 方眼。
    // overlay は frameCanvas の "前" に入れる(frameCanvas より上に来てしまうと、
    // わくが仮インクの下に隠れてしまう)。
    this.paperWrap.insertBefore(this.surface.overlay, this.frameCanvas);

    this.underlayCanvas.width = width;
    this.underlayCanvas.height = height;
    this.onionCanvas.width = width;
    this.onionCanvas.height = height;
    this.playbackCanvas.width = width;
    this.playbackCanvas.height = height;
    this.frameCanvas.width = width;
    this.frameCanvas.height = height;
    this.paperTextureCanvas.width = width;
    this.paperTextureCanvas.height = height;
    // 紙テクスチャは寸法込みで焼くので、寸法が変わったキャッシュは使い回せない。
    // syncPaperLayer() 側が getPaperTexture() 経由で作り直す。
    this.paperTextureCache.clear();

    this.sizeMinimapCanvas();
    this.applyCanvasSizeStyle();
    // 新しい Surface は overprint を持たないので、いまのわくを渡し直す
    // (渡し忘れると寸法を変えた途端、保存の絵からわくが消える)。
    this.syncFrameLayer(this.currentFrame);
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

  /**
   * かさねの帯。「マス」のようにパネルを開く経路には乗せず、押すたびに帯を出し入れする
   * トグルにする(仕様: かさねモード)。実際に Surface を触る処理はハンドラ側(このクラス)に
   * 閉じ込め、LayerStrip 自身は Surface を知らない形にしてある。
   */
  private buildLayerStrip(): void {
    this.layerStrip = new LayerStrip(this.stage, {
      onSelect: (id) => this.selectLayerTile(id),
      onToggleVisible: (id) => this.toggleLayerVisibleTile(id),
      onReorder: (id, toIndex) => this.reorderLayerTile(id, toIndex),
      onAdd: () => this.addLayerTile(),
      // 「けす」は帯からは直接消さず、まず確かめを挟む(元に戻せないため)。
      // 実際に消す処理(removeLayerTile)は確かめで「けす」が選ばれたときだけ呼ぶ。
      onRemove: (id) => this.confirmRemoveLayerTile(id),
      // ドラッグの持ち上げ/落としの合図。並べ替え自体(reorderLayerTile)には
      // 別の音を足さない(ここで鳴らす分で「落とした」感触は十分なため)。
      onDragLift: () => this.sound.play("poko"),
      onDragEnd: () => this.sound.play("poko"),
    });
    // 確かめの表示自体は Surface を知らなくてよい(帯と同じ考え方)。消してよいか
    // 決まった後の実処理だけ、このクラス(main.ts)が引き取る。
    this.removeLayerConfirm = new RemoveLayerConfirm(this.stage, {
      onConfirm: (id) => this.removeLayerTile(id),
      onCancel: () => {
        // 「やめる」を選んだだけなので何も変えない。音も鳴らさない
        // (guide.ts 同様、キャンセルは「何も起きなかった」ことが伝わる方が安全)。
      },
    });
    // パラパラを始める確かめ。「けす」と違って対象の id を持たないので、
    // onConfirm の引数(RemoveLayerConfirm.show に渡した id)は使わない。
    this.flattenLayersConfirm = new RemoveLayerConfirm(
      this.stage,
      {
        onConfirm: () => void this.startFlipbook(),
        onCancel: () => {
          // 「やめる」と同じ扱い。何も変えない・音も鳴らさない。
        },
      },
      {
        message: [{ base: "かさねを 1まいに まとめるよ" }],
        confirm: [{ base: "まとめる" }],
        cancel: [{ base: "やめる" }],
      },
    );

    // コマの帯(手順4a/4b)。かさねの帯と同じ場所・同じ触り方(LayerStrip)を、コマ向けの
    // options で流用する。「けす」は直接消さず、まず確かめを挟む(かさねの帯と同じ理由。
    // removeFrameConfirm 参照)。並べ替えの持ち上げ/落としの音もかさねの帯と揃える。
    this.frameStrip = new LayerStrip(
      this.stage,
      {
        onSelect: (id) => void this.selectFrame(id),
        onToggleVisible: () => {
          // allowToggleVisible:false で使うので実際には呼ばれない(コマ自体を隠す概念が無いため)。
        },
        onReorder: (id, toIndex) => void this.reorderFrame(id, toIndex),
        onAdd: () => void this.addFrame(),
        onRemove: (id) => this.confirmRemoveFrame(id),
        onDragLift: () => this.sound.play("poko"),
        onDragEnd: () => this.sound.play("poko"),
      },
      {
        order: "top-down",
        allowToggleVisible: false,
        showNumbers: true,
        addPosition: "end",
        allowRemove: true,
        allowReorder: true,
        className: "is-frames",
        text: {
          add: [{ base: "＋" }, { base: "コマを" }, { base: "ふやす" }],
          select: [{ base: "この" }, { base: "コマに" }, { base: "きりかえる" }],
        },
      },
    );
    // コマを消す確かめ。かさねの removeLayerConfirm とは別インスタンス(既定文言のまま使う。
    // どのコマを消すかは confirmRemoveFrame 側の id で持つ)。
    this.removeFrameConfirm = new RemoveLayerConfirm(this.stage, {
      onConfirm: (id) => void this.removeFrame(id),
      onCancel: () => {
        // 「やめる」と同じ扱い。何も変えない・音も鳴らさない。
      },
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

  /**
   * 「わく」(コマ割り)のお手本を選ぶ行(docs/manga.md)。紙の行(createPaperRow)と
   * 同じ作り(nib-button を並べるだけ)にして、操作を覚え直させない。
   * 紙・マス・わくは互いに独立した軸なので、3 行とも同時に選択状態を持てる。
   */
  private createFrameRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "frame-row";
    // ツールバー・下敷きの帯と同じく、入りきらないものは横に流す(makeHScrollPanelRow のコメント参照)。
    const { track } = makeHScrollPanelRow(row);
    for (const id of FRAME_PRESET_ORDER) {
      const def = FRAME_PRESETS[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.frame = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", plainText(def.label));
      button.addEventListener("click", () => this.setFramePreset(id));
      track.appendChild(button);
    }
    this.frameRow = row;
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
    // 作品が切り替わる経路はすべてここを通る(コメント参照)ので、再生中なら必ず止める
    // (docs/animation.md「見る」止まる経路: 作品の切り替え)。
    this.stopPlayback();
    this.paperKind = this.work?.paperKind ?? "plain";
    this.syncPaperLayer();
    // 作品が切り替わる経路(openWork/createWork/trashWork/revertTo/restore)は
    // すべてここを通るので、パラパラ中の「かさね」休ませをまとめて乗せる。
    this.syncFlipbookButtons();
    // 切り替え前の作品の札の絵(ImageBitmap)を握ったままにしない。
    this.clearFrameThumbCache();
    // パラパラの作品を開いたらコマの帯を出し、そうでなければ必ず閉じる
    // (layerStripVisible と同じく、開けっぱなしのまま別の作品を開く事故を作らないため)。
    this.setFrameStripVisible(this.work?.animation === true);
    // 「うすく」も作品を開いた経路の1つなのでここで揃える(clearFrameThumbCache の後、
    // 古いキャッシュが残っていない状態で読み直させる)。
    this.syncOnion();
  }

  /**
   * frameThumbCache(小さい canvas)と onionBitmapCache(原寸 ImageBitmap 1枚)を空にする
   * (古い作品の画像を握ったままにしない)。小さい canvas は close() を持たないので参照を
   * 外すだけでよい(GC 任せ)。原寸ビットマップは close() で明示的に手放す。
   */
  private clearFrameThumbCache(): void {
    this.frameThumbCache.clear();
    this.frameThumbCacheSize = null;
    this.clearOnionBitmapCache();
  }

  /** onionBitmapCache が握っている原寸 ImageBitmap(約8MB)を close() して手放す。 */
  private clearOnionBitmapCache(): void {
    this.onionBitmapCache?.bitmap.close();
    this.onionBitmapCache = null;
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
    panel.element.appendChild(this.createPatternRow());
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

  /**
   * 「塗る」パネルの 2 行目、もよう(トーン)を選ぶ行(docs/manga.md「決めたこと:トーン」)。
   * かこみ/しかく/まる の行(上の row)と同じ作り(nib-button を並べるだけ)にして、
   * 押したときの振る舞いも揃える(パネルは閉じず、「塗る」を選んだ状態にして音を鳴らす)。
   * もようは色と違い「置く」というより「選ぶ」感覚なので音は solid だけ通常の "shu"、
   * それ以外は他の一覧選びと同じ "poko" にする。
   */
  private createPatternRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "pattern-row";
    const { track } = makeHScrollPanelRow(row);
    for (const id of PATTERN_ORDER) {
      const def = PATTERNS[id];
      const button = document.createElement("button");
      button.className = "nib-button";
      button.dataset.pattern = id;
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.innerHTML = def.iconSvg;
      const label = document.createElement("span");
      label.className = "label";
      label.appendChild(renderRuby(def.label));
      button.append(icon, label);
      button.setAttribute("aria-label", plainText(def.label));
      button.addEventListener("click", () => {
        this.fillPattern = id;
        this.setActiveTool("fill");
        this.syncPatternButtons();
        this.sound.play(id === "solid" ? "shu" : "poko");
      });
      track.appendChild(button);
    }
    this.patternRow = row;
    return row;
  }

  /**
   * もようの行の選択状態(is-active)を揃える。マス目に吸着するモード(this.cellGrid !== null、
   * ビーズ・ドット絵)ではもようが効かない(今までどおりのべた塗り)ので、行ごと薄くする
   * (押せなくはしない。docs/manga.md「決めたこと:トーン」)。
   */
  private syncPatternButtons(): void {
    for (const element of this.patternRow.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.pattern === this.fillPattern);
    }
    this.patternRow.classList.toggle("is-dim", this.cellGrid !== null);
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
    // わく(コマ割り)の行。パネルの一番下に置く(写真の帯・濃さの行より後ろ)。
    // 写真の帯はすぐ上の「写真」ボタンの下に出てほしいので、間に割り込ませない。
    panel.element.appendChild(this.createFrameRow());
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
   * パラパラの作品を開いている間だけ出す、右側縦並びの入れ物(docs/animation.md 手順5
   * 「うすく」、手順6「見る」を並べる予定)。stage-toggles(右上、音/全画面/かくす/
   * フィルタ/ぜんぶ見る)とは別の入れ物にして、その下へ重ならないよう置く
   * (座標は style.css の .flipbook-controls 参照)。
   */
  private buildFlipbookControls(): void {
    this.flipbookControls = document.createElement("div");
    this.flipbookControls.className = "flipbook-controls";
    this.stage.appendChild(this.flipbookControls);
    // 「見る」を「うすく」の上に置く(docs/animation.md「見る」)。
    // flex-direction: column の縦並びなので、先に足した方が上に来る。
    this.buildPlaybackToggle();
    this.buildOnionToggle();
  }

  /**
   * 「見る」ボタン。見た目は onionButton と同じ規格(.tool-button + 浮かせる影)。
   * 押すたびに startPlayback() が開始/停止をトグルする。
   */
  private buildPlaybackToggle(): void {
    const button = document.createElement("button");
    button.className = "tool-button playback-toggle";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = PLAY_SVG;
    const label = document.createElement("span");
    label.className = "label";
    label.appendChild(renderRuby([{ base: "見", ruby: "み" }, { base: "る" }]));
    button.append(icon, label);
    button.setAttribute("aria-label", "みる");
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => void this.startPlayback());
    this.flipbookControls.appendChild(button);
    this.playbackButton = button;
  }

  /**
   * 「うすく」ボタン。見た目はツールバーの道具ボタン(.tool-button)の規格に揃える
   * (大きさ・角丸・ラベル)。ツールバーには乗せず flipbookControls に浮かべるので、
   * 浮いて見えるよう影だけ style.css 側で足す(.onion-toggle)。
   */
  private buildOnionToggle(): void {
    const button = document.createElement("button");
    button.className = "tool-button onion-toggle";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = ONION_SVG;
    const label = document.createElement("span");
    label.className = "label";
    label.appendChild(renderRuby([{ base: "うすく" }]));
    button.append(icon, label);
    button.setAttribute("aria-label", "うすく");
    button.addEventListener("click", () => {
      this.onionEnabled = !this.onionEnabled;
      this.syncOnion();
      this.sound.play("poko");
    });
    this.flipbookControls.appendChild(button);
    this.onionButton = button;
  }

  /**
   * flipbookControls(「うすく」ボタン)の出し入れ・見た目と、onionCanvas の中身をまとめて
   * 今の状態に揃える。パラパラの作品を開いている間だけ出す(docs/animation.md「うすく」)。
   * 呼び出しは「作品を開いた時・startFlipbook・selectFrame・addFrame・removeFrame・
   * reorderFrame の後」に限る(描くたびには呼ばない。前のコマは描いている間は変わらないため)。
   */
  private syncOnion(): void {
    const inFlipbook = this.work?.animation === true;
    this.flipbookControls.classList.toggle("is-visible", inFlipbook);
    this.onionButton?.classList.toggle("is-active", this.onionEnabled);
    void this.updateOnionLayer();
  }

  /**
   * onionCanvas に「今のコマの直前のコマ」の絵(PageData.image、合成済み PNG)を描く。
   * 1 コマ目・パラパラでない作品・スイッチ OFF のときは隠す。
   *
   * コマの帯とは別に onionBitmapCache(原寸 ImageBitmap 1枚だけ)を持つ(frameThumbCache は
   * 札の大きさへ縮めた小さい canvas しか持たないため、原寸が要るここでは使い回せない)。
   * createImageBitmap は非同期なので、読み終わる前にコマ・作品が切り替わっていたら
   * (onionGeneration がずれていたら)描かずに捨てる。
   */
  private async updateOnionLayer(): Promise<void> {
    const generation = ++this.onionGeneration;
    const work = this.work;
    if (work?.animation !== true || !this.onionEnabled) {
      this.onionCanvas.classList.remove("is-on");
      // スイッチを切った/パラパラでない作品に移ったら、原寸ビットマップ(約8MB)も
      // すぐ手放す。使っていない間まで持ち続ける理由が無い。
      this.clearOnionBitmapCache();
      return;
    }
    const pages = work.pages.filter((page) => !page.deleted);
    const activeIndex = pages.findIndex((page) => page.id === currentPageOf(work)?.id);
    const prevPage = activeIndex > 0 ? pages[activeIndex - 1] : undefined;
    if (prevPage === undefined) {
      // 1コマ目(またはコマが見つからない異常時)は前のコマが無いので隠す。
      this.onionCanvas.classList.remove("is-on");
      this.clearOnionBitmapCache();
      return;
    }
    let bitmap: ImageBitmap;
    if (this.onionBitmapCache?.versionId === prevPage.versionId) {
      bitmap = this.onionBitmapCache.bitmap;
    } else {
      const loaded = await createImageBitmap(prevPage.image);
      // 読み込みの間にコマ・作品が切り替わっていたら、この結果はもう要らない。
      if (generation !== this.onionGeneration) {
        loaded.close();
        return;
      }
      // 「直前の1コマ」だけを持つ約束(1枚約8MB)なので、入れ替える前に古い方を閉じる。
      this.onionBitmapCache?.bitmap.close();
      this.onionBitmapCache = { versionId: prevPage.versionId, bitmap: loaded };
      bitmap = loaded;
    }
    if (this.onionCtx !== null) {
      this.onionCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
      this.onionCtx.drawImage(bitmap, 0, 0, this.canvasWidth, this.canvasHeight);
    }
    this.onionCanvas.classList.add("is-on");
  }

  // --- 見る(パラパラ再生) ------------------------------------------------

  /**
   * 「見る」を始める。docs/animation.md「見る」の手順そのまま:
   *  ①再生中ならトグルで止める → ②コマが2枚未満なら始めずガイド →
   *  ③今描いた線も入るよう保存 → ④その時点の pages(deleted 除く)の image を控える →
   *  ⑤1コマ目を読み終えてから表示を始める(空白を出さない) →
   *  ⑥requestAnimationFrame で進める(playbackTick)。
   */
  private async startPlayback(): Promise<void> {
    if (this.playing) {
      this.stopPlayback(); // ①
      return;
    }
    const work = this.work;
    if (work === null || work.animation !== true) return; // 「見る」自体がパラパラの作品でしか出ない。
    if (work.pages.filter((p) => !p.deleted).length < 2) {
      // ② うすく・コマの帯と同じ「今のところ何も起きない」パターン。
      if (this.playbackButton !== null) this.guide.show("コマを ふやすと うごくよ", this.playbackButton);
      return;
    }
    await this.save(); // ③ 今描いた線も再生に入れる。
    const saved = this.work;
    if (saved === null) return; // 型のための保険。save() の間に作品が消えることは無い想定。
    const frames = saved.pages.filter((p) => !p.deleted).map((p) => p.image); // ④
    if (frames.length < 2) return; // 保険(save() の間に構成が変わることは無い想定)。

    // ここから先の非同期読み込みが古い呼び出しの結果で上書きしないよう世代を進める。
    const generation = ++this.playbackGeneration;
    const firstBlob = frames[0];
    if (firstBlob === undefined) return;
    let firstBitmap: ImageBitmap;
    try {
      firstBitmap = await createImageBitmap(firstBlob); // ⑤
    } catch (error) {
      console.warn("さいせいの よみこみに しっぱいしました", error);
      return;
    }
    if (generation !== this.playbackGeneration) {
      // 読み込みの間にもう一度「見る」が押された/止められた等で世代がずれた。
      firstBitmap.close();
      return;
    }

    this.playbackFrames = frames;
    this.playbackIndex = 0;
    this.playbackBitmaps.set(0, firstBitmap);
    this.playing = true;
    this.enterPlaybackMode();
    this.drawPlaybackFrame(firstBitmap);
    this.ensurePlaybackWindow(generation); // この先2コマの先読みを始める。

    this.playbackNextDueAt = performance.now() + FLIPBOOK_FRAME_MS;
    this.playbackRaf = requestAnimationFrame((ts) => this.playbackTick(ts, generation)); // ⑥
    this.sound.play("fanfare");
  }

  /**
   * 「見る」を止める。docs/animation.md「見る」の止まる経路(紙を押す/もう一度押す/
   * 他のツールボタン/コマの帯の操作/作品の切り替え・ギャラリー/画面が裏に回った)は
   * すべてここを呼ぶ。read み込み中のものは世代番号(playbackGeneration)で捨てさせる。
   */
  private stopPlayback(): void {
    if (!this.playing) return;
    this.playing = false;
    this.playbackGeneration++; // 進行中の非同期読み込みをすべて無効化する。
    if (this.playbackRaf !== null) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    for (const bitmap of this.playbackBitmaps.values()) bitmap.close();
    this.playbackBitmaps.clear();
    this.playbackLoading.clear();
    this.playbackFrames = [];
    this.playbackIndex = 0;
    this.exitPlaybackMode();
  }

  /**
   * 再生 canvas を出し、紙を押せなくし(pointer-events は style.css の .is-on 側)、
   * 「うすく」を一時的に隠し(状態そのものは onionEnabled のまま変えない)、
   * ボタンの見た目を選ばれている状態にする。
   */
  private enterPlaybackMode(): void {
    this.playbackCanvas.classList.add("is-on");
    this.onionCanvas.classList.remove("is-on");
    // 再生は各コマの焼き込み済みの絵(わく込み)を出すので、今のコマのわくが上に
    // 重なると他のコマとずれて見える。再生中だけ frameCanvas を隠す。
    this.frameCanvas.classList.add("is-playing");
    this.playbackButton?.classList.add("is-active");
    this.playbackButton?.setAttribute("aria-pressed", "true");
  }

  /** enterPlaybackMode() を巻き戻す。「うすく」は syncOnion() で元の状態に揃え直す。 */
  private exitPlaybackMode(): void {
    this.playbackCanvas.classList.remove("is-on");
    this.frameCanvas.classList.remove("is-playing");
    this.playbackButton?.classList.remove("is-active");
    this.playbackButton?.setAttribute("aria-pressed", "false");
    this.syncOnion();
  }

  /**
   * requestAnimationFrame のループ本体。playbackNextDueAt を過ぎていて、次のコマの
   * ビットマップが既に読み終えていれば1コマ進める。間に合っていなければ、そのコマを
   * 飛ばさず今の絵のまま待つ(docs/animation.md「少しずつ読む」)。
   * generation が今の playbackGeneration と食い違っていたら(=止められた後の古い呼び出し)
   * 何もせず終わる。
   */
  private playbackTick(timestamp: number, generation: number): void {
    if (!this.playing || generation !== this.playbackGeneration) return;
    if (timestamp >= this.playbackNextDueAt) {
      const length = this.playbackFrames.length;
      const targetIndex = (this.playbackIndex + 1) % length;
      const bitmap = this.playbackBitmaps.get(targetIndex);
      if (bitmap !== undefined) {
        this.drawPlaybackFrame(bitmap);
        this.playbackIndex = targetIndex;
        this.playbackNextDueAt = timestamp + FLIPBOOK_FRAME_MS;
        this.ensurePlaybackWindow(generation);
      }
      // bitmap が undefined ならまだ読み終えていない = 今の絵のまま待つ。
      // playbackNextDueAt は動かさないので、次の tick でも読み終わっていればすぐ進む。
    }
    this.playbackRaf = requestAnimationFrame((ts) => this.playbackTick(ts, generation));
  }

  /** 今のコマ・この先2コマ(最大3枚)だけをメモリに持つよう、足りない分を読み・要らない分を閉じる。 */
  private ensurePlaybackWindow(generation: number): void {
    const length = this.playbackFrames.length;
    if (length === 0) return;
    const wanted = new Set<number>([0, 1, 2].map((offset) => (this.playbackIndex + offset) % length));
    // 窓の外に出たビットマップはすぐ手放す(1枚約8MBなので溜めない)。
    for (const [index, bitmap] of this.playbackBitmaps) {
      if (!wanted.has(index)) {
        bitmap.close();
        this.playbackBitmaps.delete(index);
      }
    }
    for (const index of wanted) {
      if (this.playbackBitmaps.has(index) || this.playbackLoading.has(index)) continue;
      void this.loadPlaybackBitmap(generation, index, wanted);
    }
  }

  /** ensurePlaybackWindow() から呼ぶ、1コマぶんの先読み。 */
  private async loadPlaybackBitmap(generation: number, index: number, wanted: ReadonlySet<number>): Promise<void> {
    const blob = this.playbackFrames[index];
    if (blob === undefined) return;
    this.playbackLoading.add(index);
    try {
      const bitmap = await createImageBitmap(blob);
      if (generation !== this.playbackGeneration || !wanted.has(index)) {
        // 読み込みの間に止められた、またはもう窓の外(先へ進んだ)になった。
        bitmap.close();
        return;
      }
      this.playbackBitmaps.set(index, bitmap);
    } catch (error) {
      console.warn("さいせいの よみこみに しっぱいしました", error);
    } finally {
      this.playbackLoading.delete(index);
    }
  }

  /** playbackCanvas に1コマ分描く。 */
  private drawPlaybackFrame(bitmap: ImageBitmap): void {
    if (this.playbackCtx === null) return;
    this.playbackCtx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.playbackCtx.drawImage(bitmap, 0, 0, this.canvasWidth, this.canvasHeight);
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
    // ボタンを作り直したので、パラパラ中の見た目(is-dim/is-active)も揃え直す。
    this.syncFlipbookButtons();
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
    // 「見る」ボタン自体はここを通らない(別ハンドラ)が、他の道具ボタンはどれを押しても
    // 再生を止める(docs/animation.md「見る」止まる経路)。
    this.stopPlayback();
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
        this.syncPatternButtons();
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
      case "layers":
        // 「マス」と違いパネルを開くのではなく、押すたびに帯を出し入れするだけのトグル。
        this.setLayerStripVisible(!this.layerStripVisible);
        this.sound.play(this.layerStripVisible ? "fanfare" : "poko");
        break;
      case "flipbook":
        this.onFlipbookButton();
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
   * かさねの帯の出し入れ。状態は保存しない(「かくす」と同じ考え方で、次に開いたときは
   * 必ず閉じた状態から始める。開けっぱなしのまま別の作品を開く事故を作らないため)。
   */
  private setLayerStripVisible(visible: boolean): void {
    this.layerStripVisible = visible;
    this.layerStrip.setVisible(visible);
    this.buttons.get("layers")?.classList.toggle("is-active", visible);
    // 閉じている間の変化(描く・undo等)を取りこぼさないよう、開いた瞬間に必ず最新へ揃える。
    if (visible) this.syncLayerStrip();
  }

  /**
   * コマの帯の出し入れ。状態は保存しない(layerStripVisible と同じ考え方。
   * 次に開いたときは必ず閉じた状態から始める)。
   */
  private setFrameStripVisible(visible: boolean): void {
    this.frameStripVisible = visible;
    this.frameStrip.setVisible(visible);
    if (visible) void this.syncFrameStrip();
  }

  /**
   * 「パラパラ」ボタン。docs/animation.md「パラパラの開始・解除」。
   * 始める／やめるの切り替えボタン。既にパラパラの作品では stopFlipbook() でやめ、
   * そうでなければ始める(かさねが 2 枚以上ある作品では、まとめてよいか一度だけ確かめる。
   * 1 枚ならそのまま始まる)。
   */
  private onFlipbookButton(): void {
    if (this.work?.animation === true) {
      void this.stopFlipbook();
      return;
    }
    if (this.surface.layerCount > 1) {
      const { width, height } = this.layerThumbnailSize();
      this.flattenLayersConfirm.show("flatten", width, (canvas) => this.surface.drawCompositeThumbnail(canvas));
      return;
    }
    void this.startFlipbook();
  }

  /**
   * パラパラを開始する。かさねを見えているものだけの 1 枚にまとめ、作品を
   * animation:true にする。手順は docs/animation.md の順番のまま:
   *  ①途中の描き込みを保存 → ②まとめる直前を控える → ③まとめる →
   *  ④animation を立てる → ⑤かさねの帯を閉じる → ⑥まとめた絵を保存 → ⑦ボタンを揃える → ⑧音
   */
  private async startFlipbook(): Promise<void> {
    // 作品がまだ無い(this.work === null)ときも、この save() が空の作品を作ってから進む。
    await this.save();
    // まとめる直前の姿を控える。隠していたかさねは flattenVisibleLayers() で消えるが、
    // ここで撮った控え(SnapshotReason "flatten")が「前に戻す」の受け皿になる。
    await this.captureSnapshot("flatten");
    this.surface.flattenVisibleLayers();
    if (this.work === null) return; // 型のため。直前の save() で必ず作られている。
    this.work = { ...this.work, animation: true };
    // 1 コマ 1 枚の約束を画面でも守るため、開いていたら閉じる。
    this.setLayerStripVisible(false);
    // まとめた絵を今の姿として焼き直すため(flattenVisibleLayers() は scheduleSave() を通らない)。
    this.dirty = true;
    await this.save();
    this.syncHistoryButtons();
    this.syncFlipbookButtons();
    // パラパラを始めた直後はコマの帯を出す(docs/animation.md「コマの帯」)。
    this.setFrameStripVisible(true);
    // 始めた直後は1コマ目だけなので前のコマは無い(syncOnion 内で隠す判定になる)が、
    // 「うすく」ボタン自体はここで出す。
    this.syncOnion();
    this.sound.play("fanfare");
  }

  /**
   * パラパラをやめる。docs/animation.md「パラパラの開始・解除」。
   * いつでも解除でき、コマは pages に残したまま(消すのは「けす」でだけ行う操作なので、
   * ここでは一切触らない)。開いていたコマ(activePageId)もそのまま、普通の絵として
   * 描き続けられる(かさねも増やせる)。もう一度「パラパラ」を押せば、残っていたコマごと
   * startFlipbook() で戻る(startFlipbook() は pages に触らないため)。
   *
   * 手順: ①再生中なら止める → ②今の描きかけを保存 → ③animation を倒す →
   * ④焼き直さずに書く(addFrame の setPaperKind と同じ作法) → ⑤コマの帯を隠す →
   * ⑥「かさね」ボタン・「パラパラ」の見た目を揃える → ⑦「見る」「うすく」を隠す → ⑧音
   * frameBusy はコマの帯の操作(selectFrame 等)と共用(構成を書き換える処理同士の再入を防ぐ)。
   */
  private async stopFlipbook(): Promise<void> {
    this.stopPlayback(); // ①
    if (this.frameBusy) return;
    if (this.work === null) return;
    this.frameBusy = true;
    try {
      await this.save(); // ② 今の描きかけをやめる前のコマへ焼く。
      if (this.work === null) return; // 型のための保険。
      this.work = { ...this.work, animation: false }; // ③
      this.dirty = false; // ④ animation を倒しただけで絵は焼き直していない。
      await this.putFrameWork(this.work);
      this.setFrameStripVisible(false); // ⑤
      this.syncFlipbookButtons(); // ⑥ 「かさね」ボタンを戻し、「パラパラ」の is-active を外す。
      this.syncOnion(); // ⑦ inFlipbook===false になったので「見る」「うすく」も隠れる。
      this.syncHistoryButtons();
      this.sound.play("poko"); // ⑧
    } finally {
      this.frameBusy = false;
    }
  }

  /**
   * パラパラ中は「かさね」ボタンを休ませ、「パラパラ」ボタンを選ばれている見た目にする
   * (docs/animation.md「パラパラ中は「かさね」ボタンを休ませる」。1 コマ 1 枚の約束を
   * 画面でも守るための同期)。作品が切り替わる全経路は applyWorkPaper() を必ず通る
   * (openWork/createWork/trashWork/revertTo/restore が呼んでいる共通の入口)ので、
   * そこと、ツールバーを描き直した後(renderToolbar)、パラパラを始めた直後
   * (startFlipbook)から呼ぶ。
   */
  private syncFlipbookButtons(): void {
    const inFlipbook = this.work?.animation === true;
    this.setHistoryButtonEnabled("layers", !inFlipbook);
    this.buttons.get("flipbook")?.classList.toggle("is-active", inFlipbook);
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
    // アクティブな 1 枚(paperCanvas)だけでなく全レイヤーに掛けないと、他のレイヤーだけ
    // 補間が残って見た目が揃わないので Surface 側にまとめて掛けさせる。
    this.surface.setPixelated(this.gridMode === "dot");
    // 写真の下敷きは、下敷きが実際にあるときだけ見せる。
    this.underlayCanvas.classList.toggle("is-on", this.gridMode === "photo" && this.underlayRecord !== null);
    for (const element of this.gridPanel.element.querySelectorAll<HTMLElement>(".grid-mode-row .nib-button")) {
      element.classList.toggle("is-active", element.dataset.grid === this.gridMode);
    }
    // ツールバーの「マス」ボタンの見た目(is-active・アイコン)を揃える。
    // syncFrameLayer() からも(帯の再読み込み等を走らせずに)この部分だけ呼べるよう、
    // 小さい関数に切り出す。
    this.syncGridButtonAppearance();
    // gridMode が変わるたびに帯の表示・非表示も追従させる(ここが唯一の入口)。
    void this.refreshUnderlayStrip();
    this.syncUnderlayOpacityRow();
    this.syncUnderlayToggle();
    // マス目に吸着するモードに切り替わったら、もようの行も薄くする(docs/manga.md)。
    this.syncPatternButtons();
  }

  /**
   * ツールバーの「マス」ボタンの見た目だけを揃える(syncGridButtons の一部を切り出したもの)。
   * 「マス」はマスの下敷きが選ばれているときだけでなく、わくがあるときも点灯させる
   * (docs/manga.md「決めたこと:画面」)。アイコンは gridMode があればそちらを優先し、
   * gridMode が off でわくだけあるときは、そのお手本のアイコン(framePresetOf が null な
   * 崩れた形のときは 4 こまのアイコンで代用する)を出す。
   */
  private syncGridButtonAppearance(): void {
    const button = this.buttons.get("grid");
    const hasFrame = this.currentFrame !== undefined;
    button?.classList.toggle("is-active", this.gridMode !== "off" || hasFrame);
    const icon = button?.querySelector(".icon");
    if (icon == null) return;
    if (this.gridMode === "off" && hasFrame) {
      const presetId = framePresetOf(this.currentFrame) ?? "yonkoma";
      icon.innerHTML = FRAME_PRESETS[presetId].iconSvg;
    } else {
      icon.innerHTML = GRID_MODES[this.gridMode].iconSvg;
    }
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
          // マス目に吸着するモードでは、もようは効かず今までどおりのべた塗り
          // (docs/manga.md「決めたこと:トーン」)。
          const tile = this.cellGrid === null ? patternTile(this.fillPattern, this.color) : null;
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
              tile,
            );
            return;
          }
          // ビーズは円で置くので画素をたどる塗りつぶしだと背景へ漏れる。マス単位で広げる。
          const cellGrid = this.cellGrid;
          const rect = cellGrid !== null
            ? this.surface.fillCells(cellGrid, point.x, point.y, this.color)
            : this.surface.fill(point.x, point.y, hexToRgba(this.color), tile);
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
          const tile = this.cellGrid === null ? patternTile(this.fillPattern, this.color) : null;
          this.surface.previewShape(drag.mode, drag.x, drag.y, point.x, point.y, this.color, this.cellGrid, tile);
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
          const tile = this.cellGrid === null ? patternTile(this.fillPattern, this.color) : null;
          const rect = this.surface.fillShape(
            drag.mode,
            drag.x,
            drag.y,
            drag.endX,
            drag.endY,
            this.color,
            this.cellGrid,
            tile,
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
    // かさねの帯もここで揃える。「描き終わり・undo・redo・作品を開く/戻す」等、
    // 履歴が動くタイミングがすべてこの syncHistoryButtons() を通る(main.ts 内を grep 済み)ので、
    // 同じ入口に乗せておけば取りこぼしが無い。常時再描画はしない(描き心地に響くため)。
    this.syncLayerStrip();
    // コマの帯も同じ入口に乗せる。ただし見えているときだけ(syncLayerStrip と違い、
    // こちらは他コマの PNG を毎回 createImageBitmap するコストがあるため)。
    if (this.frameStripVisible) void this.syncFrameStrip();
  }

  /**
   * かさねの帯を今の Surface の状態へ合わせる。中身の並び替え(LayerStrip.sync)に加えて、
   * 札ごとの小さい絵も一緒に描き直す(Surface.drawLayerThumbnail はここでしか呼ばない)。
   */
  private syncLayerStrip(): void {
    const items: LayerStripItem[] = this.surface.layerList;
    this.layerStrip.sync(items, (id, canvas) => {
      const { width, height } = this.layerThumbnailSize();
      // 寸法が変わった時だけ張り替える(canvas は width/height を書き換えると中身が消えるため、
      // 変わっていないのに毎回書き換えるとちらつきの原因になる)。
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      this.surface.drawLayerThumbnail(id, canvas);
    });
  }

  /**
   * コマの帯を今の作品(pages)の状態へ合わせる。かさねの帯(syncLayerStrip)と同じ形だが、
   * こちらは「見えているもの」ではなく WorkRecord.pages(消えていないもの)が並びの源。
   * 札の絵は、今開いているコマは Surface の今の姿(描いた線がすぐ出るように)、
   * それ以外のコマは PageData.image(前回 save() した合成済み PNG)から作る。
   */
  private async syncFrameStrip(): Promise<void> {
    const work = this.work;
    if (work === null) return;
    const pages = work.pages.filter((page) => !page.deleted);
    // 消したコマ・古い版(保存のたびに versionId が変わる、docs/page-versions.md)の
    // 小さい絵をキャッシュに残さない。切り替えを繰り返しても溜まり続けないようにする掃除。
    const liveVersionIds = new Set(pages.map((page) => page.versionId));
    for (const versionId of this.frameThumbCache.keys()) {
      if (!liveVersionIds.has(versionId)) this.frameThumbCache.delete(versionId);
    }
    const activeId = currentPageOf(work)?.id;
    const items: LayerStripItem[] = pages.map((page) => ({
      id: page.id,
      // かさねの見せる/隠すの概念をコマは持たない(allowToggleVisible:false)ので、
      // ここは常に true/1 で固定する(LayerStripItem の型を再利用しているだけ)。
      visible: true,
      opacity: 1,
      active: page.id === activeId,
    }));
    this.frameStrip.sync(items, (id, canvas) => {
      const { width, height } = this.layerThumbnailSize();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (id === activeId) {
        this.surface.drawCompositeThumbnail(canvas);
        return;
      }
      const page = pages.find((p) => p.id === id);
      if (page !== undefined) this.drawFramePageThumbnail(page, canvas);
    });
    // 24 の上限に達していたら「＋」を薄く見せる(押せるまま。docs/animation.md「決めたこと」)。
    this.frameStrip.setAddDimmed(pages.length >= FRAME_LIMIT);
  }

  /**
   * 「今のコマ以外」の札 1 枚ぶんの絵を描く。PageData.image(PNG Blob、1748x1181で
   * 1枚約8MB)を createImageBitmap で読んでから Surface.drawImageThumbnail() で
   * 札の大きさ(layerThumbnailSize())へ縮める。読み込みは非同期なので、呼んだ時点では
   * まだ描けない。
   *
   * 原寸の ImageBitmap はキャッシュせず、縮めた小さい canvas だけを frameThumbCache に
   * versionId でキャッシュする(原寸のまま24コマぶん持つと約200MBになり、iPhone/古い iPad
   * の Safari ではタブごと落ちかねないため)。縮め終わったら原寸はすぐ close() して手放す。
   * キャッシュ済みなら、その小さい canvas をそのまま drawImage で写すだけでよい
   * (的の大きさは layerThumbnailSize() で揃えてあるので、改めて縮小し直す必要が無い)。
   *
   * コマの帯(syncFrameStrip)だけでなく、けすの確かめ(confirmRemoveFrame)からも呼ぶので、
   * 帯が閉じているかどうかは見ない(canvas.isConnected だけで十分。確かめの canvas は
   * 帯とは別の DOM に常時ある)。
   */
  private drawFramePageThumbnail(page: PageData, canvas: HTMLCanvasElement): void {
    const size = this.layerThumbnailSize();
    // devicePixelRatio の変化等で札の大きさ自体が変わっていたら、古い大きさの小さい
    // canvas はもう的に合わないので丸ごと作り直す。
    if (
      this.frameThumbCacheSize === null ||
      this.frameThumbCacheSize.width !== size.width ||
      this.frameThumbCacheSize.height !== size.height
    ) {
      this.frameThumbCache.clear();
      this.frameThumbCacheSize = size;
    }
    const cached = this.frameThumbCache.get(page.versionId);
    if (cached !== undefined) {
      canvas.getContext("2d")?.drawImage(cached, 0, 0);
      return;
    }
    void createImageBitmap(page.image).then((bitmap) => {
      const small = document.createElement("canvas");
      small.width = size.width;
      small.height = size.height;
      this.surface.drawImageThumbnail(bitmap, small);
      bitmap.close(); // 縮め終わったら原寸(約8MB)はすぐ手放す。
      this.frameThumbCache.set(page.versionId, small);
      // 読み終わる頃には作品が切り替わっている/この canvas が差し替えられていることがある。
      // まだ画面に居る canvas にだけ描く。
      if (!canvas.isConnected) return;
      canvas.getContext("2d")?.drawImage(small, 0, 0);
    });
  }

  /**
   * 札の絵の実ピクセル寸法。.layer-tile-select の中身(82x82、CSS 側の寸法と揃えてある)
   * と同じ正方形にする。作品ごとに紙の縦横比が違う(縦長/横長)ため、比率を保った
   * レターボックス描画は Surface.drawLayerThumbnail() 側の役目にし、ここでは
   * 「実ピクセルと CSS 表示サイズを一致させる」ことだけ担当する(そこがずれていると
   * 縦横比を保って描いても最後にブラウザが引き伸ばしてしまう)。
   */
  private layerThumbnailSize(): { width: number; height: number } {
    // CSS 表示サイズは 82px のまま変えない(.layer-tile-select の中身と同じ82x82、
    // 上のコメント参照)。実ピクセルだけを devicePixelRatio 倍にして、高精細な画面
    // (Retina 等)でも線がぼやけず・粗く出ないようにする。上限を3倍に頭打ちにするのは、
    // devicePixelRatio が4以上ある端末で毎回数百px四方のcanvasへ縮小するのは
    // 帯を開くたびのコストに見合わないため(3倍=246pxで十分にくっきり見える)。
    const cssSize = 82;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const size = Math.round(cssSize * dpr);
    return { width: size, height: size };
  }

  /** 札を押して、そのかさねへ切り替える。 */
  private selectLayerTile(id: string): void {
    if (!this.surface.setActiveLayer(id)) return;
    this.afterHistoryChange();
    this.sound.play("poko");
  }

  /**
   * 選ばれている札をもう一度タップ: 見せる/隠すを切り替える。
   * 目のアイコンを無くした分、この操作は「いま選んでいるかさね」にしか効かない
   * (選ばれていない札のタップは selectLayerTile 側で拾う。layerStrip.ts 参照)。
   *
   * ここでは「いま選んでいるかさねを隠したら隣へ自動で切り替える」手当てはしない
   * (以前はあったが、切り替わってしまうと、もう一度タップしても「選ぶ」に戻り、
   * 元に戻す動作にならず2で決めた作法と噛み合わなくなる)。代わりに
   * Surface.beginStroke 等が「隠れたまま描いたら自動で見せる」を担う
   * (surface.ts の revealActiveLayerIfHidden 参照)。
   * ただし見えているかさねが他に1枚も無いときは、隠すこと自体を行わない
   * (全部消えて白紙になり、何が起きたか分からなくなるため。この判断は維持する)。
   */
  private toggleLayerVisibleTile(id: string): void {
    const items = this.surface.layerList;
    const target = items.find((item) => item.id === id);
    if (target === undefined) return;
    const hiding = target.visible;

    if (hiding) {
      const othersVisible = items.some((item) => item.id !== id && item.visible);
      if (!othersVisible) return;
    }

    this.surface.setLayerVisible(id, !hiding);
    this.afterHistoryChange();
    this.sound.play(hiding ? "shu" : "poko");
  }

  /**
   * ドラッグでの並べ替え。toIndex は LayerStrip 側で既に Surface.moveLayer と同じ約束
   * (0が一番下)へ変換済みなので、ここでは素直に渡すだけでよい。効果音は
   * buildLayerStrip の onDragLift/onDragEnd 側で鳴らす(ここで重ねて鳴らすと
   * 持ち上げ→落とすの2回に対して音が増えすぎる)。
   */
  private reorderLayerTile(id: string, toIndex: number): void {
    if (!this.surface.moveLayer(id, toIndex)) return;
    this.afterHistoryChange();
  }

  /**
   * 「＋ふやす」。SOFT_LAYER_LIMIT 以上のときは実際には増やさず、軽く知らせるだけにする。
   * 上限で弾いて何も起きないと、なぜ増えないのか子どもには分からないため
   * (Surface 自体にハードな上限は無い。ここは UI 側の判断)。
   */
  private addLayerTile(): void {
    if (this.surface.layerCount >= SOFT_LAYER_LIMIT) {
      const anchor = this.buttons.get("layers") ?? this.layerStrip.element;
      this.guide.show("もう じゅうぶん あるよ", anchor);
      return;
    }
    this.surface.addLayer();
    this.afterHistoryChange();
    this.sound.play("poko");
  }

  /**
   * 帯の「けす」が押された直後。ここではまだ何も消さず、画面中央に確かめを出す。
   * 消す絵そのもの(サムネイル)を確かめ側の canvas に描き直すのは、帯の札(syncLayerStrip)
   * と同じく Surface.drawLayerThumbnail をここで呼ぶ形にする(確かめ側は Surface を
   * 知らなくてよい形のまま)。
   */
  private confirmRemoveLayerTile(id: string): void {
    const { width, height } = this.layerThumbnailSize();
    this.removeLayerConfirm.show(id, width, (canvas) => this.surface.drawLayerThumbnail(id, canvas));
  }

  /** 確かめで「けす」が選ばれた後の実処理。最後の1枚は Surface.removeLayer 自体が false を返す(ボタン側も既に無効化済み)。 */
  private removeLayerTile(id: string): void {
    if (!this.surface.removeLayer(id)) return;
    this.afterHistoryChange();
    this.sound.play("shu");
  }

  /**
   * コマの帯の札を押して、そのコマへ切り替える(docs/animation.md「コマの帯」)。
   * frameBusy で連打・非同期処理中の再入を防ぐ(切り替えの途中でもう一度押されると
   * activePageId の付け替えと保存が入り乱れて絵を取り違える事故になるため)。
   *
   * 手順の順番は厳守: ①今のコマのうちに描きかけを保存 → ②activePageId を切り替え先へ
   * → ③切り替え先の絵を描き戻す(undo履歴も捨てる=「戻る」は今のコマの中だけ)
   * → ④activePageId だけが変わったので焼き直さずに書く(setPaperKind と同じ作法)。
   * ①を後にすると、まだ activePageId が切り替え先を向いている間に保存が走り、
   * 今の絵(切り替え元のもの)が切り替え先のコマへ焼かれてしまう。
   */
  private async selectFrame(id: string): Promise<void> {
    // コマの帯の操作はどれも再生を止める(docs/animation.md「見る」止まる経路)。
    this.stopPlayback();
    if (this.frameBusy) return;
    if (this.work === null) return;
    if (currentPageOf(this.work)?.id === id) return; // 今のコマの再タップは何もしない。
    this.frameBusy = true;
    try {
      await this.save(); // ①
      if (this.work === null) return; // 型のための保険。save() の間に作品が消えることは無い想定。
      this.work = { ...this.work, activePageId: id }; // ②
      const page = currentPageOf(this.work);
      if (page === undefined) return;
      await this.restorePage(page); // ③
      await this.putFrameWork(this.work); // ④
      this.syncHistoryButtons();
      this.syncOnion(); // 切り替え先の1つ前のコマへ描き直す。
      this.sound.play("poko");
    } finally {
      this.frameBusy = false;
    }
  }

  /**
   * 「＋コマをふやす」。今のコマのすぐ後ろに白紙のコマを足し、そのコマへ移る
   * (docs/animation.md「コマの帯」)。24 の上限に達していたら増やさず、
   * かさねの SOFT_LAYER_LIMIT(addLayerTile)と同じ作法で軽く知らせるだけにする。
   * frameBusy は selectFrame と共用(コマの構成を書き換える処理同士の再入を防ぐ)。
   *
   * 手順: ①今のコマの描きかけを保存 → ②白紙にする(Surface.reset())→
   * ③白紙を焼いて新しい PageData を作る → ④今のコマのすぐ後ろに差し込み、
   * activePageId を新しいコマに → ⑤既に焼いてあるので save() は通さず、
   * dirty も立てないまま store.put(setPaperKind と同じ作法)。
   */
  private async addFrame(): Promise<void> {
    // コマの帯の操作はどれも再生を止める(docs/animation.md「見る」止まる経路)。
    this.stopPlayback();
    if (this.frameBusy) return;
    if (this.work === null) return;
    // 上限チェックは frameBusy を立てる前に行う(押せるまま、の約束。
    // frameStrip.setAddDimmed() で「＋」自体は薄く見せているが disabled にはしていないので、
    // 押されたらここで必ず弾く)。
    const activeFrameCount = this.work.pages.filter((p) => !p.deleted).length;
    if (activeFrameCount >= FRAME_LIMIT) {
      this.guide.show("ここまでだよ", this.frameStrip.element);
      return;
    }
    this.frameBusy = true;
    try {
      await this.save(); // ①
      if (this.work === null) return;
      const currentPage = currentPageOf(this.work);
      const currentId = currentPage?.id;
      // 新しいコマは「今のコマのわく」を引き継ぐ(コマ割りの中で動きを描くのが自然で、
      // コマごとに敷き直させないため。docs/manga.md「描画と保存」)。syncFrameLayer() は
      // 呼ばない: 今の frameCanvas/overprint がそのまま見えていて、reset() はかさねの
      // 画素だけを白紙にするので overprint(=わく)には触らず、toPng() にもそのまま乗る。
      const currentFrame = currentPage?.frame;
      this.surface.reset(); // ②

      const pageId = createId("page"); // ③
      const image = await this.surface.toPng();
      const layerImages = await this.surface.toLayerImages();
      const layers = layerImages.map((layer) => ({ ...layer, deleted: false }));
      const newPage: PageData = {
        id: pageId,
        image,
        deleted: false,
        layers,
        activeLayerId: this.surface.activeLayerId,
        versionId: createId("ver"),
        ...(currentFrame === undefined ? {} : { frame: currentFrame }),
      };

      const insertAt = this.work.pages.findIndex((p) => p.id === currentId); // ④
      const pages = [...this.work.pages];
      pages.splice(insertAt === -1 ? pages.length : insertAt + 1, 0, newPage);
      this.work = { ...this.work, pages, activePageId: pageId, updatedAt: Date.now() };

      this.dirty = false; // ⑤ 既に焼いてあるので save() は通さない。
      await this.putFrameWork(this.work);
      this.syncHistoryButtons();
      this.syncOnion(); // 新しいコマの直前(=元居たコマ)を描き直す。
      this.sound.play("poko");
    } finally {
      this.frameBusy = false;
    }
  }

  /**
   * コマの帯の「けす」が押された直後。まだ何も消さず、画面中央に確かめを出す
   * (removeLayerConfirm/confirmRemoveLayerTile と同じ二段構え)。サムネイルは
   * 今のコマなら Surface の今の姿(drawCompositeThumbnail)、他のコマは
   * 一覧の札と同じ描き方(drawFramePageThumbnail、PageData.image から作る)。
   */
  private confirmRemoveFrame(id: string): void {
    // 「けす」を押した時点で止める(確かめの間、裏で再生し続けない)。
    this.stopPlayback();
    const work = this.work;
    if (work === null) return;
    const { width, height } = this.layerThumbnailSize();
    this.removeFrameConfirm.show(id, width, (canvas) => {
      if (id === currentPageOf(work)?.id) {
        this.surface.drawCompositeThumbnail(canvas);
        return;
      }
      const page = work.pages.find((p) => p.id === id);
      if (page !== undefined) this.drawFramePageThumbnail(page, canvas);
    });
  }

  /**
   * 確かめで「けす」が選ばれた後の実処理(docs/animation.md「コマを消す」)。
   * 最後の 1 コマは LayerStrip 側で「けす」ボタン自体を無効化しているので、
   * ここへは普通は来ない(念のため下でも同じ条件を見る)。
   *
   * 手順は指示書の順番のまま:
   *  ①frameBusy ガード → ②今の描きかけを保存 → ③消す直前の姿を控える
   *  (「前に戻す」の受け皿) → ④pages から外す(最後の1コマは消さない) →
   *  ⑤消したのが今のコマなら、同じ位置の次のコマ(無ければ前のコマ)へ切り替える →
   *  ⑥表紙が変わっていたら焼き直す → ⑦保存 → ⑧ボタンを揃える・音
   */
  private async removeFrame(id: string): Promise<void> {
    if (this.frameBusy) return; // ①
    if (this.work === null) return;
    const work = this.work;
    const activePages = work.pages.filter((p) => !p.deleted);
    if (activePages.length <= 1) return; // 最後の1コマは消さない。
    const removeIndex = activePages.findIndex((p) => p.id === id);
    if (removeIndex === -1) return;

    this.frameBusy = true;
    try {
      await this.save(); // ②
      if (this.work === null) return;
      await this.captureSnapshot("removeFrame"); // ③
      if (this.work === null) return;

      const oldCoverId = this.work.pages.find((p) => !p.deleted)?.id;
      const wasCurrent = currentPageOf(this.work)?.id === id;
      const pages = this.work.pages.filter((p) => p.id !== id); // ④
      this.work = { ...this.work, pages, updatedAt: Date.now() };

      if (wasCurrent) {
        // ⑤ 消したコマと同じ位置(添字)にいたコマが繰り上がって「次のコマ」になる。
        // 末尾を消した場合は繰り上がりが無いので、代わりに新しい末尾(=前のコマ)を開く。
        const remaining = pages.filter((p) => !p.deleted);
        const nextPage = remaining[removeIndex] ?? remaining[remaining.length - 1];
        if (nextPage === undefined) return; // 型のための保険(上の length<=1 チェック済み)。
        this.work = { ...this.work, activePageId: nextPage.id };
        await this.restorePage(nextPage);
      }

      const newCoverId = pages.find((p) => !p.deleted)?.id;
      if (newCoverId !== oldCoverId) await this.refreshCoverThumbnail(); // ⑥

      await this.putFrameWork(this.work); // ⑦
      this.syncHistoryButtons(); // ⑧
      this.syncOnion(); // 消えたコマが「直前のコマ」だった場合等に備えて描き直す。
      this.sound.play("shu");
    } finally {
      this.frameBusy = false;
    }
  }

  /**
   * コマの帯のドラッグ並べ替え(docs/animation.md「コマの帯」)。かさねの帯と違い、
   * 今のコマ自体は動かないので保存(save())は不要 -- 描きかけは dirty のまま残り、
   * 次の save() が activePageId(=id)で正しいコマへ焼く(setPaperKind と同じ考え方で、
   * pages の並びだけを直接書き換える)。
   */
  private async reorderFrame(id: string, toIndex: number): Promise<void> {
    // コマの帯の操作はどれも再生を止める(docs/animation.md「見る」止まる経路)。
    this.stopPlayback();
    if (this.frameBusy) return;
    if (this.work === null) return;
    this.frameBusy = true;
    try {
      const work = this.work;
      const oldCoverId = work.pages.find((p) => !p.deleted)?.id;
      const fromIndex = work.pages.findIndex((p) => p.id === id);
      if (fromIndex === -1) return;
      const pages = [...work.pages];
      const [moved] = pages.splice(fromIndex, 1);
      if (moved === undefined) return;
      pages.splice(Math.min(toIndex, pages.length), 0, moved);
      this.work = { ...work, pages, updatedAt: Date.now() };

      const newCoverId = pages.find((p) => !p.deleted)?.id;
      if (newCoverId !== oldCoverId) await this.refreshCoverThumbnail();

      await this.putFrameWork(this.work);
      this.syncHistoryButtons();
      this.syncOnion(); // 並び順が変わったので「直前のコマ」も変わりうる。
    } finally {
      this.frameBusy = false;
    }
  }

  /**
   * 表紙(work.thumbnail、一覧に出る絵)を今の pages[0](消えていない最初のページ)の
   * 絵から作り直す。表紙が今開いているコマなら Surface の今の姿を焼き(save() と同じ
   * toThumbnail())、そうでなければ表紙の PageData.image から作る(thumbnailFromImage、
   * surface.ts)。docs/animation.md「表紙サムネイル」。
   */
  private async refreshCoverThumbnail(): Promise<void> {
    if (this.work === null) return;
    const cover = this.work.pages.find((p) => !p.deleted);
    if (cover === undefined) return;
    const thumbnail =
      cover.id === currentPageOf(this.work)?.id
        ? await this.surface.toThumbnail()
        : await thumbnailFromImage(cover.image);
    if (this.work === null) return; // 型のための保険(await の間に閉じられることは無い想定)。
    this.work = { ...this.work, thumbnail };
  }

  /**
   * コマの構成(pages・activePageId)を書き換えた後の保存。selectFrame/addFrame/
   * removeFrame/reorderFrame で共用する。失敗しても例外を外へ漏らさず、dirty を立てて
   * おく -- 次の save()(今のコマの描き込みを焼くついで)が work を丸ごと書き直すので、
   * ここで取りこぼしたコマの構成もそのとき一緒に書かれる(取りこぼしが残らない)。
   */
  private async putFrameWork(work: WorkRecord): Promise<void> {
    try {
      await this.store.put(work);
    } catch (error) {
      this.dirty = true;
      console.warn("コマの ほぞんに しっぱいしました", error);
    }
  }

  /**
   * ボタン要素は素の <button> なので、disabled 属性そのものを使って押せなくする。
   * 元は「戻る/進む」専用だったが、パラパラ中に「かさね」を休ませるのにも同じ見た目
   * (is-dim + disabled)が要るため、id は ToolId 全般を受けられるようにしてある。
   */
  private setHistoryButtonEnabled(id: ToolId, enabled: boolean): void {
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
    // ギャラリーを開くのも止まる経路の1つ(docs/animation.md「見る」)。
    this.stopPlayback();
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
   * わく(docs/manga.md)を frameCanvas に描き直し、Surface へも「合成に重ねる 1 枚」として
   * 渡し直す。1 つの canvas を「画面に見せる層」と「合成に重ねる 1 枚」の両方に使う
   * (別々に描くと、画面の見た目と保存・書き出しの絵とでわくの線がずれる事故になる)。
   */
  private syncFrameLayer(frame: FrameData | undefined): void {
    this.currentFrame = frame;
    if (frame !== undefined && this.frameCtx !== null) {
      drawFrame(this.frameCtx, frame, this.canvasWidth, this.canvasHeight);
      this.frameCanvas.classList.add("is-on");
      this.surface.setOverprint(this.frameCanvas);
    } else {
      this.frameCtx?.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
      this.frameCanvas.classList.remove("is-on");
      this.surface.setOverprint(null);
    }
    // わくが変わる経路はすべてここを通るので、選択状態の同期もここに乗せる。
    this.syncFrameButtons();
    this.syncGridButtonAppearance();
  }

  /** 「わく」の行(.frame-row)の選択状態(is-active)を今の currentFrame に揃える。 */
  private syncFrameButtons(): void {
    const activeId = framePresetOf(this.currentFrame);
    for (const element of this.frameRow.querySelectorAll<HTMLElement>(".nib-button")) {
      element.classList.toggle("is-active", element.dataset.frame === activeId);
    }
  }

  /**
   * お手本を選んでわくを切り替える(docs/manga.md「決めたこと:画面」)。
   * コマごとに持つので、今のページだけを差し替える(他のページには触らない)。
   * 「わく」は戻る(undo)の対象にしない(押し直せば済むし、履歴に混ぜると
   * 「戻る」で枠が消えて子どもが驚くため)。パネルはマスと同じく開いたままにする。
   */
  private setFramePreset(id: FramePresetId): void {
    if (this.work === null) return;
    // 同じお手本を押し直しても何もしない(framePresetOf で今の中身と比べる)。
    if (framePresetOf(this.currentFrame) === id) return;
    const page = currentPageOf(this.work);
    if (page === undefined) return;
    const frame = FRAME_PRESETS[id].frame ?? undefined;
    const pages = this.work.pages.map((p) => {
      if (p.id !== page.id) return p;
      if (frame === undefined) {
        const { frame: _dropped, ...withoutFrame } = p;
        return withoutFrame;
      }
      return { ...p, frame };
    });
    this.work = { ...this.work, pages };
    // 画素は変わらないが frame が変わるので、必ず scheduleSave() を通す
    // (通さないと保存されない。docs/manga.md「描画と保存」)。
    this.syncFrameLayer(frame);
    this.scheduleSave();
    // パラパラ中は、コマの帯の今のコマの札を新しい絵(わく込み)で描き直す。
    // save() 自体はコマの帯を更新しないので、描いた後(afterHistoryChange 相当)と
    // 同じ呼び出しをここでもする。
    if (this.frameStripVisible) void this.syncFrameStrip();
    this.sound.play(id === "none" ? "shu" : "poko");
  }

  /**
   * 保存されたページ 1 枚を Surface へ描き戻す。
   * レイヤーがあればそのまま組み直し、無い(壊れている)ときだけ合成結果 1 枚に落とす。
   *
   * syncFrameLayer() は restoreLayers()/restoreFrom() の "後" に呼ぶ。どちらも
   * composite()(＝わくを含む合成)は使わず、保存されていた画素をそのまま Surface へ
   * 描き戻すだけなので、前後どちらでも結果は変わらない。ならば後にしておけば、
   * 「描き戻した後の絵に、そのページのわくを重ねる」という順番が素直に読める。
   */
  private async restorePage(page: PageData): Promise<void> {
    if (page.layers.length > 0) await this.surface.restoreLayers(page.layers, page.activeLayerId);
    else await this.surface.restoreFrom(page.image);
    this.syncFrameLayer(page.frame);
  }

  /**
   * 選んだ履歴の姿に戻す。戻す直前の姿も履歴に積むので、巻き戻し自体をやり直せる
   * (「戻したらもっとひどくなった」を作らない)。
   */
  private async revertTo(workId: string, snapshotId: string): Promise<void> {
    const work = await this.store.get(workId);
    const snapshot = work?.snapshots.find((item) => item.id === snapshotId);
    // 控えに 1 コマも無ければ戻しようが無い(全コマ消去という異常時の保険。
    // docs/animation.md「前に戻す」は控えの全コマを対象にするので、ここも pages[0] だけでなく
    // 控え全体で判断する)。
    if (work === null || work === undefined || snapshot === undefined || snapshot.pages.length === 0) return;

    // 巻き戻す作品を開いていない場合は、まずそちらへ移る。
    if (this.work?.id !== workId) {
      await this.save();
      this.work = work;
      this.applyWorkPaper();
      // 作品を切り替えたので、スマホ/タブレットに合わせた最初の見え方からやり直す。
      this.applyInitialView();
    }
    await this.captureSnapshot("revert");
    // 「前に戻す」は控えの全コマを今の姿にする(docs/animation.md「決めたこと」)。
    // 今開いていたコマと同じ id が控えにあれば引き続きそのコマを開き、無ければ
    // (コマが入れ替わった/消えていた等)控えの 1 コマ目を開く。
    const activeId = this.work?.activePageId;
    const page =
      (activeId !== undefined ? snapshot.pages.find((p) => p.id === activeId && !p.deleted) : undefined) ??
      snapshot.pages.find((p) => !p.deleted) ??
      snapshot.pages[0];
    if (page === undefined || this.work === null) return;
    this.work = { ...this.work, pages: snapshot.pages, activePageId: page.id };
    // 履歴画像は work と同じ寸法で焼かれているので、work の寸法に揃えてから描き戻す。
    this.applyCanvasSize(work.canvasWidth, work.canvasHeight);
    await this.restorePage(page);
    // 描き戻した控えの絵を今の姿として書くため。restorePage は scheduleSave を通らないので
    // ここで立てないと save() が「変わっていない」と誤解して素通りしてしまう。
    this.dirty = true;
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
    const page = work ? currentPageOf(work) : undefined;
    if (work === null || work === undefined || page === undefined) return;
    // 開く作品の寸法に合わせてから描き戻す(いまは全作品 1748x1181 なので実質は保険)。
    this.applyCanvasSize(work.canvasWidth, work.canvasHeight);
    await this.restorePage(page);
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
    // 前の作品のわくを引き継がず、この寸法の初期わく(size.initialFrame。無ければわく無し)に
    // 切り替えてから焼く(2026-09-26: マンガの紙は 4 こまのわく付きで始める。docs/manga.md)。
    // toPng() より前に切り替えるので、保存の絵にもわくが入る。
    const initial = size.initialFrame;
    const frame = initial ? FRAME_PRESETS[initial].frame ?? undefined : undefined;
    this.syncFrameLayer(frame);
    // 空の作品をこの場で作って開いた状態にする。
    // 「あたらしく かく」を押した時点で一覧に 1 枚増えていないと、描く前に閉じた子の絵が迷子になる。
    this.work = createWork(
      await this.surface.toPng(),
      Date.now(),
      await this.surface.toThumbnail(),
      size.width,
      size.height,
    );
    // 作った 1 ページ目にも同じわくを持たせる(コマごとに持つので、Surface 側の
    // 見た目(frameCanvas)と PageData.frame がずれないようにする)。
    if (frame !== undefined) {
      this.work = { ...this.work, pages: this.work.pages.map((p) => ({ ...p, frame })) };
    }
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
        // ここも createWork() と同じ理由で、白紙を焼く前に前の作品のわくを外す。
        this.syncFrameLayer(undefined);
        this.work = createWork(await this.surface.toPng(), Date.now(), await this.surface.toThumbnail());
        await this.store.put(this.work);
      } else {
        this.applyCanvasSize(next.canvasWidth, next.canvasHeight);
        const page = currentPageOf(next);
        if (page !== undefined) await this.restorePage(page);
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
    this.dirty = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
  }

  private async save(): Promise<void> {
    // 中身が変わっていない保存は何もしない(まだ作品が無い最初の保存だけは必ず焼く)。
    if (this.work !== null && !this.dirty) return;
    // 焼き始める前に倒しておく。焼いている間に描かれた分は scheduleSave() がまた
    // 立ててくれるので、ここで倒しても取りこぼさない。
    this.dirty = false;
    const png = await this.surface.toPng();
    const now = Date.now();
    let work = this.work;
    if (work === null) {
      work = createWork(png, now, await this.surface.toThumbnail());
    } else {
      // 今のコマ(docs/animation.md「保存」)だけを焼き直し、他のコマは前の PageData を
      // そのまま使う(版を増やさない)。今のコマ以外を Surface に無い絵で上書きしないよう、
      // id が一致するページだけを差し替える。
      const currentPage = currentPageOf(work);
      const targetId = currentPage?.id ?? work.pages[0]?.id ?? "page-0";
      // Surface が実際に持っているレイヤー構成をそのまま書く(image は従来通り合成結果)。
      // 各レイヤーは透過のまま保存する(toLayerImages() 参照。紙色で塗ると復元時に
      // 上のレイヤーが下を隠してしまう)。id は Surface 側のものをそのまま使うので、
      // 保存のたびに別レイヤー扱いになることはない。
      const layerImages = await this.surface.toLayerImages();
      const layers = layerImages.map((layer) => ({ ...layer, deleted: false }));
      const activeLayerId = this.surface.activeLayerId;
      // base を PageData で受ける(id・deleted だけでなく frame も持ち回す)。
      // frame を通さないと、今のコマだけ焼き直す自動保存のたびにわくが消えてしまう
      // (画素は変わらなくても、bake() が PageData を丸ごと作り直すため)。
      const bake = (base: Pick<PageData, "id" | "deleted" | "frame">): PageData => ({
        id: base.id,
        image: png,
        deleted: base.deleted,
        layers,
        activeLayerId,
        // 絵を焼き直すたびに新しい版(docs/page-versions.md「版 ID の規則」)。
        versionId: createId("ver"),
        ...(base.frame === undefined ? {} : { frame: base.frame }),
      });
      let matched = false;
      let pages = work.pages.map((p) => {
        if (p.id !== targetId) return p;
        matched = true;
        return bake(p);
      });
      if (!matched) {
        // 一致するページが無い異常時(currentPageOf は本来 pages 内の id しか返さない
        // ので起きない想定だが、絵を落とさないことを優先して 1 枚目として書き足す)。
        pages = [bake({ id: targetId, deleted: false }), ...pages];
      }
      // サムネイルは一覧の表紙用(コマ 1 = 消えていない最初のページ)なので、
      // それ以外のコマを保存したときは古いサムネイルのまま据え置く(無駄に焼かない)。
      const coverPage = work.pages.find((p) => !p.deleted) ?? work.pages[0];
      const isCover = coverPage !== undefined && coverPage.id === targetId;
      const thumbnail = isCover ? await this.surface.toThumbnail() : work.thumbnail;
      work = { ...work, updatedAt: now, pages, activePageId: targetId, thumbnail };
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
      // 書き込めていないので、次の保存でやり直せるよう立て直す。
      this.dirty = true;
      console.warn("じどうほぞんに しっぱいしました", error);
    }
  }

  private async restore(): Promise<void> {
    try {
      // 前回ひらいていた絵の続きから。無ければいちばん新しい絵。
      const saved = this.currentWorkId === null ? null : await this.store.get(this.currentWorkId);
      const latest = saved !== null && !saved.deleted ? saved : (await this.store.list())[0];
      const page = latest ? currentPageOf(latest) : undefined;
      if (latest === undefined || page === undefined) return;
      this.applyCanvasSize(latest.canvasWidth, latest.canvasHeight);
      await this.restorePage(page);
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
