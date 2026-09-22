import { describe, expect, test } from "vitest";
import { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import { generateQrMatrix, type QrMatrix } from "./qr-matrix";

const LOCATION_URL = "https://inventory.klaymade.com/location/018b3f2c-4a6d-7e19-9b2f-5c8a1d3e7f40";
const ITEM_URL = "https://inventory.klaymade.com/item/018b3f2c-4a6d-7e19-9b2f-5c8a1d3e7f40";
const ASSET_URL = "https://inventory.klaymade.com/a/000-001";

/**
 * Renders the matrix into a luminance buffer with the 4-module quiet zone the
 * spec requires, then hands it to ZXing — the same decoder family a phone
 * camera uses. A round trip here is the strongest available proof of scanability.
 */
function decodeMatrix(matrix: QrMatrix, scale = 4, quietModules = 4): string {
  const side = (matrix.size + quietModules * 2) * scale;
  // A Uint8ClampedArray source is read as one luminance byte per pixel.
  const luminances = new Uint8ClampedArray(side * side).fill(255);

  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (!matrix.modules[r]![c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quietModules) * scale + dx;
          const y = (r + quietModules) * scale + dy;
          luminances[y * side + x] = 0;
        }
      }
    }
  }

  const source = new RGBLuminanceSource(luminances, side, side);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new QRCodeReader().decode(bitmap, hints).getText();
}

describe("generateQrMatrix", () => {
  test("canonical location URLs fit version 5 at exactly 37 modules", () => {
    const matrix = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    expect(matrix.version).toBe(5);
    expect(matrix.size).toBe(37);
    // 37 modules x 4 px is the 148 px QR box ADR 0026 specifies.
    expect(matrix.size * 4).toBe(148);
  });

  test("matrix is square and fully assigned", () => {
    const matrix = generateQrMatrix(ITEM_URL, { ecl: "M", minVersion: 5 });
    expect(matrix.modules).toHaveLength(matrix.size);
    for (const row of matrix.modules) {
      expect(row).toHaveLength(matrix.size);
      for (const module of row) expect(typeof module).toBe("boolean");
    }
  });

  test("finder patterns are placed in all three corners", () => {
    const { modules, size } = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    const corners: [number, number][] = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ];
    for (const [r0, c0] of corners) {
      // Outer ring dark, inner ring light, 3x3 core dark.
      expect(modules[r0]![c0]).toBe(true);
      expect(modules[r0 + 1]![c0 + 1]).toBe(false);
      expect(modules[r0 + 3]![c0 + 3]).toBe(true);
      expect(modules[r0 + 6]![c0 + 6]).toBe(true);
    }
  });

  test("timing patterns alternate along row and column 6", () => {
    const { modules, size } = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
  });

  test("the fixed dark module is set", () => {
    const matrix = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    expect(matrix.modules[4 * matrix.version + 9]![8]).toBe(true);
  });

  test.each([
    ["location", LOCATION_URL],
    ["item", ITEM_URL],
    ["asset", ASSET_URL],
  ])("%s payload round-trips through a real QR decoder", (_label, url) => {
    const matrix = generateQrMatrix(url, { ecl: "M", minVersion: 5 });
    expect(decodeMatrix(matrix)).toBe(url);
  });

  test("decodes at every error correction level", () => {
    for (const ecl of ["L", "M", "Q", "H"] as const) {
      const matrix = generateQrMatrix(LOCATION_URL, { ecl, minVersion: 5 });
      expect(decodeMatrix(matrix)).toBe(LOCATION_URL);
    }
  });

  test("output is deterministic across invocations", () => {
    const a = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    const b = generateQrMatrix(LOCATION_URL, { ecl: "M", minVersion: 5 });
    expect(a.modules).toEqual(b.modules);
  });

  test("UTF-8 payloads encode in byte mode and round-trip", () => {
    const text = "https://inventory.klaymade.com/location/café-naïve";
    const matrix = generateQrMatrix(text, { ecl: "M", minVersion: 5 });
    expect(decodeMatrix(matrix)).toBe(text);
  });

  test("steps up a version when the payload outgrows the minimum", () => {
    const long = `https://inventory.klaymade.com/location/${"a".repeat(120)}`;
    const matrix = generateQrMatrix(long, { ecl: "M", minVersion: 5 });
    expect(matrix.version).toBeGreaterThan(5);
    expect(decodeMatrix(matrix)).toBe(long);
  });

  test("rejects an unknown error correction level", () => {
    // @ts-expect-error deliberately invalid level
    expect(() => generateQrMatrix(LOCATION_URL, { ecl: "X" })).toThrow(/error correction/i);
  });

  test("rejects a payload that cannot fit the version ceiling", () => {
    expect(() => generateQrMatrix("x".repeat(200), { ecl: "M", minVersion: 1, maxVersion: 2 })).toThrow(/too large/i);
  });
});
