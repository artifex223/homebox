import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import {
  BREADCRUMB_MAX_WIDTH,
  CANONICAL_BASE_URL,
  LABEL_HEIGHT,
  LABEL_WIDTH,
  TITLE_MAX_WIDTH,
  binarizeImageData,
  buildCanonicalUrl,
  buildLabelSvg,
  collapseBreadcrumb,
  computeLabelLayout,
  encode1BitPng,
  escapeXml,
  fitBreadcrumb,
  fitFooter,
  layoutTitle,
  luminance,
  monoFont,
  ptToPx,
  sansFont,
  toBitPlane,
  truncateWithEllipsis,
  wrapTextLines,
  type LabelSpec,
  type TextMeasurer,
} from "./label-renderer";

const UUID = "018b3f2c-4a6d-7e19-9b2f-5c8a1d3e7f40";

/**
 * Deterministic stand-in for `CanvasRenderingContext2D.measureText`: a fixed
 * 0.58em advance per character. Proportions are close enough to a real sans
 * face to exercise the tier and wrapping logic without a browser.
 */
const measure: TextMeasurer = (text, cssFont) => {
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(cssFont)?.[1] ?? 16);
  return text.length * px * 0.58;
};

function specFor(overrides: Partial<LabelSpec> = {}): LabelSpec {
  return {
    title: "Workbench Drawer 3",
    ancestors: ["Garage", "Workbench"],
    type: "location",
    routeId: UUID,
    entityId: UUID,
    ...overrides,
  };
}

describe("buildCanonicalUrl", () => {
  test.each([
    ["location", UUID, `${CANONICAL_BASE_URL}/location/${UUID}`],
    ["item", UUID, `${CANONICAL_BASE_URL}/item/${UUID}`],
    ["entity", UUID, `${CANONICAL_BASE_URL}/item/${UUID}`],
    ["asset", "000-001", `${CANONICAL_BASE_URL}/a/000-001`],
  ] as const)("builds the %s route", (type, id, expected) => {
    expect(buildCanonicalUrl(type, id)).toBe(expected);
  });

  test("is pinned to the sovereign domain regardless of how the UI is reached", () => {
    // Printed stickers outlive LAN addressing, so the origin is never derived
    // from window.location.
    expect(buildCanonicalUrl("location", UUID)).toMatch(/^https:\/\/inventory\.klaymade\.com\//);
  });

  test("percent-encodes an id with unsafe characters", () => {
    expect(buildCanonicalUrl("asset", "a b/c")).toBe(`${CANONICAL_BASE_URL}/a/a%20b%2Fc`);
  });

  test("rejects an empty id and an unknown type", () => {
    expect(() => buildCanonicalUrl("location", "  ")).toThrow(/route id/i);
    // @ts-expect-error deliberately invalid entity type
    expect(() => buildCanonicalUrl("widget", UUID)).toThrow(/Unexpected label entity type/);
  });
});

describe("ptToPx", () => {
  test.each([
    [24, 32],
    [20, 27],
    [16, 21],
    [11, 15],
    [9, 12],
  ])("%ipt is %ipx", (pt, px) => {
    expect(ptToPx(pt)).toBe(px);
  });
});

describe("collapseBreadcrumb", () => {
  test("joins a shallow trail verbatim in upper case", () => {
    expect(collapseBreadcrumb(["Garage", "Workbench"], "STORAGE")).toBe("GARAGE > WORKBENCH");
  });

  test("elides the middle of a deep trail", () => {
    expect(collapseBreadcrumb(["Garage", "Workbench", "Rack 1", "Drawer 3"], "STORAGE")).toBe("GARAGE > … > DRAWER 3");
  });

  test("falls back when there is no ancestry", () => {
    expect(collapseBreadcrumb([], "STORAGE")).toBe("STORAGE");
    expect(collapseBreadcrumb(["", "  "], "ITEM")).toBe("ITEM");
  });
});

describe("fitBreadcrumb", () => {
  test("keeps the largest tier when the trail fits", () => {
    const fitted = fitBreadcrumb("GARAGE > WORKBENCH", measure);
    expect(fitted.fontPx).toBe(ptToPx(11));
    expect(fitted.text).toBe("GARAGE > WORKBENCH");
  });

  test("steps the font down before truncating", () => {
    const fitted = fitBreadcrumb("GARAGE > WORKBENCH RACK", measure);
    expect(fitted.fontPx).toBeLessThan(ptToPx(11));
  });

  test("never exceeds the 168 px header column", () => {
    const fitted = fitBreadcrumb("BASEMENT STORAGE > NORTH WALL SHELVING UNIT SEVEN", measure);
    const width = measure(fitted.text, sansFont(fitted.fontPx)) + 0.5 * fitted.text.length;
    expect(width).toBeLessThanOrEqual(BREADCRUMB_MAX_WIDTH);
    expect(fitted.text).toMatch(/…$/);
  });
});

describe("wrapTextLines", () => {
  test("wraps on word boundaries", () => {
    const lines = wrapTextLines("Alpha Bravo Charlie Delta", sansFont(32), 120, 3, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line, sansFont(32))).toBeLessThanOrEqual(120);
  });

  test("hard wraps a single word wider than the column", () => {
    const lines = wrapTextLines("Supercalifragilistic", sansFont(32), 60, 3, measure);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("truncates the last line rather than overflowing", () => {
    const lines = wrapTextLines("one two three four five six seven eight", sansFont(32), 80, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/…$/);
  });

  test("never returns an empty array", () => {
    expect(wrapTextLines("", sansFont(32), 200, 2, measure)).toEqual([""]);
  });
});

describe("truncateWithEllipsis", () => {
  test("leaves text that already fits untouched", () => {
    expect(truncateWithEllipsis("short", sansFont(16), 500, measure)).toBe("short");
  });

  test("appends an ellipsis and respects the budget", () => {
    const result = truncateWithEllipsis("a very long label title indeed", sansFont(16), 60, measure);
    expect(result).toMatch(/…$/);
    expect(measure(result, sansFont(16))).toBeLessThanOrEqual(60);
  });
});

describe("layoutTitle", () => {
  test("uses the 24pt tier for a short title", () => {
    const layout = layoutTitle("Bin 4", measure);
    expect(layout.fontPx).toBe(ptToPx(24));
    expect(layout.lines).toEqual(["Bin 4"]);
    expect(layout.baselines).toEqual([134]);
  });

  test("drops a tier rather than clipping a longer title", () => {
    const short = layoutTitle("Bin 4", measure);
    const long = layoutTitle("Workbench Fastener Overflow Storage Bin", measure);
    expect(long.fontPx).toBeLessThan(short.fontPx);
  });

  test("falls back to three lines at the smallest tier", () => {
    const layout = layoutTitle("Basement North Wall Shelving Unit Seven Overflow Container", measure);
    expect(layout.fontPx).toBe(ptToPx(16));
    expect(layout.lines.length).toBeLessThanOrEqual(3);
    expect(layout.baselines).toHaveLength(layout.lines.length);
  });

  test("keeps every line inside the 208 px title column", () => {
    for (const title of [
      "Bin 4",
      "Workbench Drawer 3",
      "Workbench Fastener Overflow Storage Bin",
      "Basement North Wall Shelving Unit Seven Overflow Container",
      "Antidisestablishmentarianism",
    ]) {
      const layout = layoutTitle(title, measure);
      for (const line of layout.lines) {
        expect(measure(line, sansFont(layout.fontPx)), `${title} :: ${line}`).toBeLessThanOrEqual(TITLE_MAX_WIDTH);
      }
    }
  });

  test("every baseline stays inside the title box", () => {
    const layout = layoutTitle("Basement North Wall Shelving Unit Seven Overflow", measure);
    for (const baseline of layout.baselines) {
      expect(baseline).toBeGreaterThan(64);
      expect(baseline).toBeLessThan(190);
    }
  });

  test("substitutes a placeholder for an empty title", () => {
    expect(layoutTitle("   ", measure).lines).toEqual(["Untitled"]);
  });
});

describe("computeLabelLayout", () => {
  test("produces a 148 px QR box at 4 px modules for a canonical URL", () => {
    const layout = computeLabelLayout(specFor(), measure);
    expect(layout.qr.version).toBe(5);
    expect(layout.qr.size).toBe(37);
    expect(layout.qrModulePx).toBe(4);
    expect(layout.qr.size * layout.qrModulePx).toBe(148);
    expect(layout.qrOffsetX).toBe(16);
    expect(layout.qrOffsetY).toBe(46);
  });

  test("keeps an oversized matrix inside the QR box with integer modules", () => {
    const layout = computeLabelLayout(specFor({ routeId: "z".repeat(160) }), measure);
    expect(layout.qr.version).toBeGreaterThan(5);
    expect(Number.isInteger(layout.qrModulePx)).toBe(true);
    expect(layout.qr.size * layout.qrModulePx).toBeLessThanOrEqual(148);
    expect(layout.qrOffsetX).toBeGreaterThanOrEqual(16);
  });

  test("prints an 8 character id prefix", () => {
    expect(computeLabelLayout(specFor(), measure).shortId).toBe("ID: 018b3f2c");
  });

  test("falls back to the route id when no entity id is supplied", () => {
    const layout = computeLabelLayout(specFor({ entityId: "", routeId: UUID }), measure);
    expect(layout.shortId).toBe("ID: 018b3f2c");
  });

  test("uses the type-appropriate breadcrumb fallback", () => {
    expect(computeLabelLayout(specFor({ ancestors: [] }), measure).breadcrumb).toBe("STORAGE");
    expect(computeLabelLayout(specFor({ ancestors: [], type: "item" }), measure).breadcrumb).toBe("ITEM");
  });

  test("resolves the icon through the heuristic and honours an override", () => {
    expect(computeLabelLayout(specFor({ title: "M3 Screws" }), measure).iconSlug).toBe("screw-machine-flat-top");
    expect(computeLabelLayout(specFor({ title: "M3 Screws", icon: "mdi:server" }), measure).iconSlug).toBe("server");
  });
});

describe("buildLabelSvg", () => {
  const svg = buildLabelSvg(computeLabelLayout(specFor(), measure));

  test("declares the exact thermal canvas", () => {
    expect(svg).toContain(`width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}"`);
    expect(svg).toContain(`viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}"`);
  });

  test("is well formed and ink-only", () => {
    expect(svg.trimStart().startsWith("<?xml")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // Only pure black and pure white may appear; a thermal head has no greys.
    const colours = new Set([...svg.matchAll(/#[0-9A-Fa-f]{6}/g)].map(m => m[0].toUpperCase()));
    expect([...colours].sort()).toEqual(["#000000", "#FFFFFF"]);
  });

  test("references no external resource, so the canvas cannot be tainted", () => {
    expect(svg).not.toMatch(/<image\b/);
    expect(svg).not.toMatch(/xlink:href/);
    // Only same-document fragment references are permitted (the clip paths).
    expect(svg.match(/url\([^)]*\)/g) ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/^url\(#/)]));
    expect(svg).not.toMatch(/url\((?!#)/);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  test("emits font sizes in px so metrics match the raster", () => {
    expect(svg).not.toMatch(/font-size="\d+(\.\d+)?pt"/);
    expect(svg).toMatch(/font-size="\d+px"/);
  });

  test("places the fixed geometry from ADR 0026", () => {
    expect(svg).toContain('<line x1="176" y1="190" x2="384" y2="190"');
    expect(svg).toContain('transform="translate(176, 24) scale(1.3333333333333333)"');
    expect(svg).toContain('y="46"');
    expect(svg).toContain('text-anchor="end"');
    // The badge is the apex domain; the QR carries the full canonical URL.
    expect(svg).toContain(">klaymade.com<");
  });

  test("draws one 4 px square per dark QR module", () => {
    const layout = computeLabelLayout(specFor(), measure);
    const dark = layout.qr.modules.flat().filter(Boolean).length;
    const squares = [...buildLabelSvg(layout).matchAll(/M\d+,\d+h4v4h-4z/g)].length;
    expect(squares).toBe(dark);
  });

  test("escapes markup in entity-supplied text", () => {
    const hostile = buildLabelSvg(
      computeLabelLayout(specFor({ title: 'Bin <script>&"x"', ancestors: ["A&B<C>"] }), measure)
    );
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("&lt;script&gt;");
    expect(hostile).toContain("&amp;");
  });
});

describe("fitFooter", () => {
  test("keeps the largest tier when the row fits", () => {
    const footer = fitFooter("ID: 018b3f2c", "klaymade.com", measure);
    expect(footer.fontPx).toBe(ptToPx(9));
    expect(footer.shortId).toBe("ID: 018b3f2c");
  });

  test("the id and the domain never overlap in the 208 px row", () => {
    for (const domain of ["klaymade.com", "inventory.klaymade.com"]) {
      const footer = fitFooter("ID: 018b3f2c", domain, measure);
      const idWidth = footer.shortId ? measure(footer.shortId, monoFont(footer.fontPx, "bold")) : 0;
      const domainWidth = measure(footer.domain, monoFont(footer.fontPx));
      expect(idWidth + domainWidth, domain).toBeLessThanOrEqual(TITLE_MAX_WIDTH);
    }
  });

  test("steps the font down before sacrificing the id", () => {
    const footer = fitFooter("ID: 018b3f2c", "a-very-long-sovereign-domain.example.com", measure);
    expect(footer.fontPx).toBeLessThanOrEqual(ptToPx(9));
    expect(footer.domain).toBe("a-very-long-sovereign-domain.example.com");
  });

  test("handles a label with no id at all", () => {
    const footer = fitFooter("", "klaymade.com", measure);
    expect(footer.shortId).toBe("");
    expect(footer.fontPx).toBe(ptToPx(9));
  });
});

describe("overflow clipping", () => {
  const svg = buildLabelSvg(
    computeLabelLayout(
      specFor({
        title: "Basement North Wall Shelving Unit Seven Overflow Container",
        ancestors: ["House", "Basement", "North Wall", "Shelving Unit Seven"],
      }),
      measure
    )
  );

  test("every text run is bound to a clip path", () => {
    const texts = [...svg.matchAll(/<text\b[^>]*>/g)].map(match => match[0]);
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const text of texts) expect(text, text).toMatch(/clip-path="url\(#nelko-/);
  });

  test("clip regions stay inside the right column", () => {
    for (const rect of [...svg.matchAll(/<rect x="(\d+)"[^>]*width="(\d+)"/g)].slice(1)) {
      const x = Number(rect[1]);
      const width = Number(rect[2]);
      expect(x).toBeGreaterThanOrEqual(176);
      expect(x + width).toBeLessThanOrEqual(384);
    }
  });

  test("the footer id and domain clips do not overlap", () => {
    const idRect = /id="nelko-footer-id-clip">\s*<rect x="(\d+)"[^>]*width="(\d+)"/.exec(svg)!;
    const domainRect = /id="nelko-footer-domain-clip">\s*<rect x="(\d+)"[^>]*width="(\d+)"/.exec(svg)!;
    expect(Number(idRect[1]) + Number(idRect[2])).toBeLessThanOrEqual(Number(domainRect[1]));
  });
});

describe("escapeXml", () => {
  test("escapes all five predefined entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("luminance", () => {
  test("uses the BT.601 coefficients", () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 5);
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 0, 0)).toBeCloseTo(76.245, 3);
    expect(luminance(0, 255, 0)).toBeCloseTo(149.685, 3);
    expect(luminance(0, 0, 255)).toBeCloseTo(29.07, 3);
  });
});

describe("binarizeImageData", () => {
  test("collapses every pixel to pure black or pure white", () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = i;
      data[i * 4 + 1] = i;
      data[i * 4 + 2] = i;
      data[i * 4 + 3] = 255;
    }
    binarizeImageData(data);
    for (let i = 0; i < data.length; i += 4) {
      expect([0, 255]).toContain(data[i]);
      expect(data[i + 1]).toBe(data[i]);
      expect(data[i + 2]).toBe(data[i]);
      expect(data[i + 3]).toBe(255);
    }
  });

  test("thresholds exactly at a luminance of 128", () => {
    const grey = (value: number) => {
      const data = new Uint8ClampedArray([value, value, value, 255]);
      binarizeImageData(data);
      return data[0];
    };
    expect(grey(127)).toBe(0);
    expect(grey(128)).toBe(255);
    expect(grey(0)).toBe(0);
    expect(grey(255)).toBe(255);
  });

  test("leaves no anti-aliased grey behind", () => {
    // An anti-aliased glyph edge ramp must resolve to a hard edge.
    const ramp = new Uint8ClampedArray([0, 32, 64, 96, 128, 160, 192, 224, 255].flatMap(v => [v, v, v, 255]));
    binarizeImageData(ramp);
    const values = [...ramp].filter((_, i) => i % 4 === 0);
    expect(values).toEqual([0, 0, 0, 0, 255, 255, 255, 255, 255]);
  });

  test("composites transparent pixels over white label stock", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0]);
    binarizeImageData(data);
    expect(data[0]).toBe(255);
    expect(data[3]).toBe(255);
  });

  test("resolves a coloured pixel by its luma, not its channels", () => {
    // Pure blue is dark enough to become ink; pure green is not.
    const blue = new Uint8ClampedArray([0, 0, 255, 255]);
    const green = new Uint8ClampedArray([0, 255, 0, 255]);
    binarizeImageData(blue);
    binarizeImageData(green);
    expect(blue[0]).toBe(0);
    expect(green[0]).toBe(255);
  });
});

describe("toBitPlane", () => {
  test("maps ink to 0 and paper to 1", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    expect([...toBitPlane(data, 2, 1)]).toEqual([0, 1]);
  });
});

describe("encode1BitPng", () => {
  const readChunks = (png: Uint8Array) => {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: { type: string; data: Uint8Array }[] = [];
    let offset = 8;
    while (offset < png.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
      offset += 12 + length;
    }
    return chunks;
  };

  test("emits a valid signature, chunk order and IHDR", async () => {
    const plane = new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT).fill(1);
    const png = await encode1BitPng(plane, LABEL_WIDTH, LABEL_HEIGHT);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks = readChunks(png);
    expect(chunks.map(c => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);

    const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
    expect(ihdr.getUint32(0)).toBe(LABEL_WIDTH);
    expect(ihdr.getUint32(4)).toBe(LABEL_HEIGHT);
    expect(chunks[0].data[8]).toBe(1); // bit depth 1
    expect(chunks[0].data[9]).toBe(0); // greyscale
    expect(chunks[0].data[12]).toBe(0); // no interlacing
  });

  test("round-trips the bit plane through a real zlib inflater", async () => {
    const width = 16;
    const height = 3;
    const plane = new Uint8Array(width * height).fill(1);
    plane[0] = 0; // top-left ink
    plane[width - 1] = 0; // top-right ink
    plane[width * 2 + 5] = 0;

    const png = await encode1BitPng(plane, width, height);
    const idat = readChunks(png).find(c => c.type === "IDAT")!;
    const raw = inflateSync(Buffer.from(idat.data));

    const rowBytes = Math.ceil(width / 8);
    expect(raw.length).toBe(height * (1 + rowBytes));
    for (let y = 0; y < height; y++) {
      const rowOffset = y * (1 + rowBytes);
      expect(raw[rowOffset]).toBe(0); // filter: none
      for (let x = 0; x < width; x++) {
        const bit = (raw[rowOffset + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
        expect(bit, `pixel ${x},${y}`).toBe(plane[y * width + x]);
      }
    }
  });

  test("a full-page label stays comfortably small", async () => {
    const plane = new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT).fill(1);
    const png = await encode1BitPng(plane, LABEL_WIDTH, LABEL_HEIGHT);
    expect(png.length).toBeLessThan(20_000);
  });

  test("CRCs are valid for every chunk", async () => {
    const plane = new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT).fill(1);
    const png = await encode1BitPng(plane, LABEL_WIDTH, LABEL_HEIGHT);
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let offset = 8;
    while (offset < png.length) {
      const length = view.getUint32(offset);
      const body = png.subarray(offset + 4, offset + 8 + length);
      let crc = 0xffffffff;
      for (const byte of body) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      expect(view.getUint32(offset + 8 + length)).toBe((crc ^ 0xffffffff) >>> 0);
      offset += 12 + length;
    }
  });
});
