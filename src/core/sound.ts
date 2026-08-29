// 効果音。「ぽこ」「しゅっ」程度の短い音を Web Audio で合成する
// (音声ファイルを置かない = 読み込み待ちゼロ・容量ゼロ)。
//
// プロト仕様書§6: ON/OFF 切替は必須。自動再生制限があるので
// AudioContext は最初のタップまで作らない。

export type SoundName = "poko" | "shu" | "fanfare";

export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 最初のユーザー操作から呼ぶ。二度目以降は何もしない。 */
  unlock(): void {
    if (this.ctx !== null) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    this.ctx = new Ctor();
    void this.ctx.resume();
  }

  play(name: SoundName): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (ctx === null) return;
    if (name === "fanfare") {
      // ド・ミ・ソ・ド を軽く駆け上がる。「かんせい！」だけの特別扱い。
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
        this.blip(ctx, freq, ctx.currentTime + index * 0.09, 0.12, "triangle");
      });
      return;
    }
    if (name === "poko") this.blip(ctx, 660, ctx.currentTime, 0.08, "sine");
    else this.blip(ctx, 320, ctx.currentTime, 0.06, "triangle");
  }

  private blip(ctx: AudioContext, freq: number, at: number, dur: number, type: OscillatorType): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    // 減衰させないと「ピー」と伸びて耳障りになる。
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}
