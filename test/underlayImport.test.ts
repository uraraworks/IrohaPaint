import { describe, expect, it } from "vitest";
import {
  chooseEncoding,
  isSupportedImageType,
  MAX_IMPORT_BYTES,
  UnderlayImportError,
  validateFile,
} from "../src/core/underlayImport.ts";

describe("isSupportedImageType", () => {
  it("png / jpeg / webp / gif を通す", () => {
    expect(isSupportedImageType("image/png")).toBe(true);
    expect(isSupportedImageType("image/jpeg")).toBe(true);
    expect(isSupportedImageType("image/webp")).toBe(true);
    expect(isSupportedImageType("image/gif")).toBe(true);
  });

  it("それ以外は弾く", () => {
    expect(isSupportedImageType("application/pdf")).toBe(false);
    expect(isSupportedImageType("")).toBe(false);
  });
});

describe("chooseEncoding", () => {
  it("PNG はそのまま PNG(透過を保つ)", () => {
    expect(chooseEncoding("image/png")).toEqual({ type: "image/png", quality: 1 });
  });

  it("jpeg / webp / gif は JPEG になる(写真を PNG で持つとサイズが膨らむため)", () => {
    expect(chooseEncoding("image/jpeg").type).toBe("image/jpeg");
    expect(chooseEncoding("image/webp").type).toBe("image/jpeg");
    expect(chooseEncoding("image/gif").type).toBe("image/jpeg");
  });
});

describe("validateFile", () => {
  it("種類が違えば unsupportedType を投げる", () => {
    expect.assertions(1);
    try {
      validateFile({ type: "application/pdf", size: 100 });
    } catch (error) {
      expect((error as UnderlayImportError).code).toBe("unsupportedType");
    }
  });

  it("MAX_IMPORT_BYTES を超えたら tooLarge を投げる", () => {
    expect.assertions(1);
    try {
      validateFile({ type: "image/png", size: MAX_IMPORT_BYTES + 1 });
    } catch (error) {
      expect((error as UnderlayImportError).code).toBe("tooLarge");
    }
  });

  it("種類・サイズが正常なら投げない", () => {
    expect(() => validateFile({ type: "image/png", size: MAX_IMPORT_BYTES })).not.toThrow();
  });
});
