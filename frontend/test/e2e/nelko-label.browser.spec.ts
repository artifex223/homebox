import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BinaryBitmap, DecodeHintType, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library";
import type { LabelLayout, LabelSpec } from "../../lib/nelko/label-renderer";

/**
 * Exercises the half of the label engine that unit tests cannot reach: real
 * `measureText` metrics, the SVG -> `<img>` -> canvas rasterization, and the
 * luminance binarization that has to leave a genuinely 1-bit buffer behind.
 *
 * The production module is bundled and injected into the page, so these tests
 * drive the same `createCanvasMeasurer` / `renderLabelToCanvas` /
 * `renderMonochromePng` code path the modal calls — not a reimplementation.
 */

const LABEL_WIDTH = 400;
const LABEL_HEIGHT = 240;
const UUID = "018b3f2c-4a6d-7e19-9b2f-5c8a1d3e7f40";

const SPECS: { name: string; spec: LabelSpec }[] = [
  {
    name: "location with a shallow trail",
    spec: {
      title: "Workbench Drawer 3",
      ancestors: ["Garage", "Workbench"],
      type: "location",
      routeId: UUID,
      entityId: UUID,
    },
  },
  {
    name: "location with a deep trail and a long title",
    spec: {
      title: "Basement North Wall Shelving Unit Seven Overflow",
      ancestors: ["House", "Basement", "North Wall", "Shelving Unit Seven"],
      type: "location",
      routeId: UUID,
      entityId: UUID,
    },
  },
  {
    name: "item resolved through an icon directive",
    spec: {
      title: "M3 Screws",
      ancestors: ["Workbench", "Parts Bin"],
      type: "item",
      routeId: UUID,
      entityId: UUID,
      description: "Assorted stainless\nicon: mdi:screw-machine-flat-top",
    },
  },
  {
    name: "asset label addressed by asset id",
    spec: {
      title: "Label Printer",
      ancestors: ["Office"],
      type: "asset",
      routeId: "000-001",
      entityId: UUID,
    },
  },
  {
    name: "title long enough to force the smallest tier",
    spec: {
      title: "Antidisestablishmentarianism Overflow Storage Container Number Fourteen",
      ancestors: ["Attic"],
      type: "location",
      routeId: UUID,
      entityId: UUID,
    },
  },
];

let bundle: string;

test.beforeAll(async () => {
  const { build } = await import("vite");
  const entry = fileURLToPath(new URL("../../lib/nelko/label-renderer.ts", import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      write: false,
      minify: false,
      lib: { entry, name: "Nelko", formats: ["iife"], fileName: () => "nelko.js" },
    },
  });
  // Vite's build() returns a single RollupOutput unless multiple outputs were
  // configured, which this single lib-mode build never does.
  const output = Array.isArray(result) ? result[0]!.output : (result as { output: { code: string }[] }).output;
  bundle = output[0]!.code;
});

interface RenderResult {
  layout: LabelLayout;
  canvasWidth: number;
  canvasHeight: number;
  distinctValuesBeforeThreshold: number;
  values: number[];
  alphaValues: number[];
  plane: number[];
  inkCount: number;
  pngBytes: number[];
  columnInk: { qrBox: number; rightOfLabel: number };
}

/** Runs the production render pipeline inside the page and reports what it produced. */
async function renderInBrowser(page: import("@playwright/test").Page, spec: LabelSpec): Promise<RenderResult> {
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle });

  return await page.evaluate(
    async ({ spec, width, height }) => {
      const Nelko = (window as unknown as { Nelko: typeof import("../../lib/nelko/label-renderer") }).Nelko;

      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);

      // Real browser text metrics drive the layout, exactly as the modal does.
      const { layout, svg } = Nelko.renderLabel(spec);

      // Capture the pre-threshold raster so the binarizer is provably exercised.
      const probe = document.createElement("canvas");
      probe.width = width;
      probe.height = height;
      const probeCtx = probe.getContext("2d", { willReadFrequently: true })!;
      probeCtx.fillStyle = "#FFFFFF";
      probeCtx.fillRect(0, 0, width, height);
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg decode failed"));
        img.src = url;
      });
      probeCtx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      const rawData = probeCtx.getImageData(0, 0, width, height).data;
      const greyBefore = new Set<number>();
      for (let i = 0; i < rawData.length; i += 4) greyBefore.add(rawData[i]!);

      // Production path: rasterize, binarize and paint back into the preview canvas.
      const { imageData, plane } = await Nelko.renderLabelToCanvas(canvas, svg);
      const blob = await Nelko.renderMonochromePng(svg, canvas);
      const pngBytes = [...new Uint8Array(await blob.arrayBuffer())];

      // Ink outside the QR box on the left half would mean a column overflow.
      let qrBox = 0;
      let rightOfLabel = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (plane[y * width + x] !== 0) continue;
          if (x >= 16 && x < 164 && y >= 46 && y < 194) qrBox++;
          if (x >= 384) rightOfLabel++;
        }
      }

      return {
        layout,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        distinctValuesBeforeThreshold: greyBefore.size,
        values: [...new Set([...imageData.data].filter((_, i) => i % 4 === 0))].sort((a, b) => a - b),
        alphaValues: [...new Set([...imageData.data].filter((_, i) => i % 4 === 3))],
        plane: [...plane],
        inkCount: [...plane].filter(v => v === 0).length,
        pngBytes,
        columnInk: { qrBox, rightOfLabel },
      };
    },
    { spec, width: LABEL_WIDTH, height: LABEL_HEIGHT }
  );
}

/** Reads the QR back out of the rendered raster, not out of the in-memory matrix. */
function decodeQrFromPlane(plane: number[], width: number, height: number): string {
  const luminances = new Uint8ClampedArray(width * height);
  for (let i = 0; i < plane.length; i++) luminances[i] = plane[i] === 0 ? 0 : 255;
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminances, width, height)));
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new QRCodeReader().decode(bitmap, hints).getText();
}

test.describe("Nelko label client-side rendering", () => {
  for (const { name, spec } of SPECS) {
    test(`${name}: rasterizes to a pure 1-bit 400x240 raster`, async ({ page }) => {
      const result = await renderInBrowser(page, spec);

      expect(result.canvasWidth).toBe(LABEL_WIDTH);
      expect(result.canvasHeight).toBe(LABEL_HEIGHT);

      // The raw raster must contain anti-aliased greys, otherwise the
      // binarizer is not actually being exercised by this fixture.
      expect(result.distinctValuesBeforeThreshold).toBeGreaterThan(2);

      // After thresholding only pure black and pure white may remain.
      expect(result.values).toEqual([0, 255]);
      expect(result.alphaValues).toEqual([255]);

      // A blank label would also satisfy the above, so assert real ink.
      expect(result.inkCount).toBeGreaterThan(2000);
      expect(result.inkCount).toBeLessThan(LABEL_WIDTH * LABEL_HEIGHT * 0.6);
    });

    test(`${name}: keeps every element inside its column`, async ({ page }) => {
      const result = await renderInBrowser(page, spec);
      // Nothing may paint past the right edge of the printable area.
      expect(result.columnInk.rightOfLabel).toBe(0);
      // The QR box must be substantially inked; a collapsed matrix would not be.
      expect(result.columnInk.qrBox).toBeGreaterThan(1000);
    });

    test(`${name}: produces a QR that decodes from the rendered pixels`, async ({ page }) => {
      const result = await renderInBrowser(page, spec);
      expect(decodeQrFromPlane(result.plane, LABEL_WIDTH, LABEL_HEIGHT)).toBe(result.layout.url);
      expect(result.layout.url.startsWith("https://inventory.klaymade.com/")).toBe(true);
    });

    test(`${name}: downloads a valid 1-bit PNG`, async ({ page }) => {
      const result = await renderInBrowser(page, spec);
      const png = Uint8Array.from(result.pngBytes);

      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // IHDR: bit depth 1, colour type 0 (greyscale).
      expect(png[24]).toBe(1);
      expect(png[25]).toBe(0);

      // Decode it back through the browser's own PNG decoder.
      const decoded = await page.evaluate(async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        return {
          width: bitmap.width,
          height: bitmap.height,
          values: [...new Set([...data].filter((_, i) => i % 4 === 0))].sort((a, b) => a - b),
        };
      }, result.pngBytes);

      expect(decoded.width).toBe(LABEL_WIDTH);
      expect(decoded.height).toBe(LABEL_HEIGHT);
      expect(decoded.values).toEqual([0, 255]);
    });
  }

  test("a deep ancestry trail is collapsed rather than clipped", async ({ page }) => {
    // SPECS is a fixed 5-entry literal above, so index 1 is always present.
    const result = await renderInBrowser(page, SPECS[1]!.spec);
    expect(result.layout.breadcrumb).toContain("…");
    expect(result.layout.breadcrumb.startsWith("HOUSE")).toBe(true);
  });

  test("a shallow ancestry trail is printed in full", async ({ page }) => {
    const result = await renderInBrowser(page, SPECS[0]!.spec);
    expect(result.layout.breadcrumb).toBe("GARAGE > WORKBENCH");
  });

  test("changing the icon changes the rendered raster", async ({ page }) => {
    const base = await renderInBrowser(page, SPECS[0]!.spec);
    const swapped = await renderInBrowser(page, { ...SPECS[0]!.spec, icon: "mdi:server" });
    expect(swapped.layout.iconSlug).toBe("server");
    expect(swapped.plane).not.toEqual(base.plane);
  });

  test("a canvas fed the label SVG is never tainted", async ({ page }) => {
    // renderInBrowser calls getImageData, which throws on a tainted canvas,
    // so reaching an assertion at all proves the SVG stayed self-contained.
    const result = await renderInBrowser(page, SPECS[0]!.spec);
    expect(result.plane.length).toBe(LABEL_WIDTH * LABEL_HEIGHT);
  });

  test("the rendered raster is byte-identical across renders", async ({ page }) => {
    const first = await renderInBrowser(page, SPECS[0]!.spec);
    const second = await renderInBrowser(page, SPECS[0]!.spec);
    expect(second.plane).toEqual(first.plane);
    expect(second.pngBytes).toEqual(first.pngBytes);
  });
});
