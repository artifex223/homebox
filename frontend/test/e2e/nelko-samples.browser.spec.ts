import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import type { LabelSpec } from "../../lib/nelko/label-renderer";

/** Writes real sample labels for visual review. Not an assertion suite. */
const OUT = process.env.NELKO_SAMPLE_DIR;
const UUID = "018b3f2c-4a6d-7e19-9b2f-5c8a1d3e7f40";

const SAMPLES: Record<string, LabelSpec> = {
  drawer: {
    title: "Workbench Drawer 3",
    ancestors: ["Garage", "Workbench"],
    type: "location",
    routeId: UUID,
    entityId: UUID,
  },
  "deep-trail": {
    title: "Basement North Wall Shelving Unit Seven Overflow",
    ancestors: ["House", "Basement", "North Wall", "Shelving Unit Seven"],
    type: "location",
    routeId: UUID,
    entityId: UUID,
  },
  screws: {
    title: "M3 Screws",
    ancestors: ["Workbench", "Parts Bin"],
    type: "item",
    routeId: UUID,
    entityId: UUID,
    description: "Assorted stainless",
  },
  asset: {
    title: "Label Printer",
    ancestors: ["Office"],
    type: "asset",
    routeId: "000-001",
    entityId: UUID,
  },
};

test("write sample labels", async ({ page }) => {
  test.skip(!OUT, "NELKO_SAMPLE_DIR not set");
  mkdirSync(OUT!, { recursive: true });

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
  const output = Array.isArray(result) ? result[0].output : (result as { output: { code: string }[] }).output;

  await page.goto("about:blank");
  await page.addScriptTag({ content: output[0].code });

  for (const [name, spec] of Object.entries(SAMPLES)) {
    const { svg, png } = await page.evaluate(async spec => {
      const Nelko = (window as unknown as { Nelko: typeof import("../../lib/nelko/label-renderer") }).Nelko;
      const canvas = document.createElement("canvas");
      document.body.appendChild(canvas);
      const { svg } = Nelko.renderLabel(spec);
      const blob = await Nelko.renderMonochromePng(svg, canvas);
      return { svg, png: [...new Uint8Array(await blob.arrayBuffer())] };
    }, spec);

    writeFileSync(`${OUT}/label-${name}.png`, Buffer.from(png));
    writeFileSync(`${OUT}/label-${name}.svg`, svg);
  }
});
