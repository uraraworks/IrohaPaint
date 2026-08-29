import { describe, expect, it } from "vitest";
import { floodFill } from "../src/core/floodFill.ts";

/** w x h の白いバッファを作る。 */
function makeCanvas(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  data.fill(255);
  return data;
}

function pixel(data: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const o = (y * w + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]] as number[];
}

const RED = { r: 255, g: 0, b: 0, a: 255 };

describe("floodFill", () => {
  it("白一色なら全面が塗られる", () => {
    const data = makeCanvas(4, 4);
    const rect = floodFill(data, 4, 4, 0, 0, RED, 24, 0);
    expect(rect).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(pixel(data, 4, 3, 3)).toEqual([255, 0, 0, 255]);
  });

  it("黒い線を越えない", () => {
    const w = 5;
    const data = makeCanvas(w, 3);
    // 真ん中の列を黒い壁にする
    for (let y = 0; y < 3; y += 1) {
      const o = (y * w + 2) * 4;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
    floodFill(data, w, 3, 0, 0, RED, 24, 0);
    expect(pixel(data, w, 1, 1)).toEqual([255, 0, 0, 255]); // 壁の左は塗られる
    expect(pixel(data, w, 3, 1)).toEqual([255, 255, 255, 255]); // 右は残る
  });

  it("同じ色を塗り直しても何もしない(無限ループ防止)", () => {
    const data = makeCanvas(3, 3);
    expect(floodFill(data, 3, 3, 1, 1, { r: 255, g: 255, b: 255, a: 255 })).toBeNull();
  });

  it("expand を指定すると縁を 1px ずつ外へ広げる(線のにじみを潜って消す)", () => {
    const w = 7;
    const data = makeCanvas(w, 3);
    // 中央に 2px の壁。広げても反対側までは抜けない。
    for (let y = 0; y < 3; y += 1) {
      for (const x of [3, 4]) {
        const o = (y * w + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
    floodFill(data, w, 3, 0, 0, RED, 24, 1);
    expect(pixel(data, w, 3, 1)).toEqual([255, 0, 0, 255]); // 壁の手前 1px は塗られる
    expect(pixel(data, w, 4, 1)).toEqual([0, 0, 0, 255]); // 反対側は無事
  });

  it("キャンバス外の座標は無視する", () => {
    const data = makeCanvas(3, 3);
    expect(floodFill(data, 3, 3, -1, 0, RED)).toBeNull();
    expect(floodFill(data, 3, 3, 3, 0, RED)).toBeNull();
  });
});
