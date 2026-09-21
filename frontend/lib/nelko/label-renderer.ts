/**
 * frontend/lib/nelko/label-renderer.ts
 *
 * Client-side 1-bit thermal label engine for the Nelko PM220 (50mm x 30mm
 * die-cut rolls @ 203 DPI -> a strict 400 x 240 px raster). See ADR 0026 for
 * the layout specification and ADR 0034 for the in-browser integration.
 *
 * The module is split into a pure layer (geometry, wrapping, SVG assembly,
 * luminance binarization, PNG encoding) that runs anywhere, and a thin DOM
 * layer (`rasterizeSvg`, `renderLabelToCanvas`, `downloadBlob`) that is the
 * only part requiring a browser. The pure layer is unit tested in Node; the
 * DOM layer is exercised in a real browser harness.
 */

import { generateQrMatrix, type QrMatrix } from "./qr-matrix";
import { getIconPath, resolveIcon } from "./mdi-paths";

// ---------------------------------------------------------------------------
// 1. Canonical geometry (ADR 0026)
// ---------------------------------------------------------------------------

export const LABEL_WIDTH = 400;
export const LABEL_HEIGHT = 240;

/** Sovereign destination for every printed QR payload, regardless of how the UI was reached. */
export const CANONICAL_BASE_URL = "https://inventory.klaymade.com";
export const DOMAIN_BADGE = "klaymade.com";

/**
 * Font stacks are shared by measurement and by the emitted SVG so that the
 * width we wrap against is the width the browser actually paints. Only system
 * faces are referenced: an `<img>`-rasterized SVG cannot load web fonts.
 */
export const LABEL_SANS_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const LABEL_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace';

/** QR box: 37 x 37 modules at 4 px each, vertically centred in the left column. */
export const QR_ORIGIN_X = 16;
export const QR_ORIGIN_Y = 46;
export const QR_BOX_PX = 148;

/** Right column: 32 x 32 icon, breadcrumb, title block, hairline, footer. */
export const ICON_ORIGIN_X = 176;
export const ICON_ORIGIN_Y = 24;
export const ICON_SIZE_PX = 32;
export const BREADCRUMB_X = 216;
export const BREADCRUMB_BASELINE_Y = 46;
export const BREADCRUMB_MAX_WIDTH = 168; // 216 -> 384
export const BREADCRUMB_LETTER_SPACING = 0.5;
export const TITLE_X = 176;
export const TITLE_MAX_WIDTH = 208; // 176 -> 384
export const HAIRLINE_Y = 190;
export const FOOTER_BASELINE_Y = 212;
export const RIGHT_EDGE_X = 384;

/** 1 pt = 4/3 px. Sizes are resolved to whole pixels and emitted as px so that
 *  measurement and rasterization cannot drift apart. */
export const ptToPx = (pt: number): number => Math.round((pt * 4) / 3);

const BREADCRUMB_PT_TIERS = [11, 10, 9];
const TITLE_TIERS: { pt: number; maxLines: number }[] = [
  { pt: 24, maxLines: 2 },
  { pt: 20, maxLines: 2 },
  { pt: 16, maxLines: 3 },
];
const FOOTER_PT_TIERS = [9, 8, 7];

export type LabelEntityType = "location" | "item" | "asset" | "entity";

/**
 * Measures the advance width of `text` rendered at `cssFont`
 * (a CSS `font` shorthand, e.g. `bold 32px <stack>`).
 */
export type TextMeasurer = (text: string, cssFont: string) => number;

export interface LabelSpec {
  /** Entity title shown as the label's headline. */
  title: string;
  /** Ancestor names ordered root-first, excluding the entity itself. */
  ancestors?: string[];
  /** Entity kind; selects both the canonical URL shape and the fallback icon. */
  type: LabelEntityType;
  /** Path segment for the canonical URL: the entity UUID, or the asset id for `asset`. */
  routeId: string;
  /** Entity UUID, printed as the `ID: ` footer prefix. */
  entityId?: string;
  /** Explicit MDI slug override selected in the modal. */
  icon?: string | null;
  /** Entity description, scanned for an `icon: mdi:<slug>` directive. */
  description?: string;
}

export interface LabelLayout {
  qr: QrMatrix;
  qrModulePx: number;
  qrOffsetX: number;
  qrOffsetY: number;
  iconSlug: string;
  iconPath: string;
  breadcrumb: string;
  breadcrumbFontPx: number;
  titleLines: string[];
  titleFontPx: number;
  titleBaselines: number[];
  shortId: string;
  domain: string;
  footerFontPx: number;
  url: string;
}

// ---------------------------------------------------------------------------
// 2. Canonical URL construction
// ---------------------------------------------------------------------------

/**
 * Builds the sovereign URL a printed sticker resolves to. Printed media
 * outlives LAN addressing, so the origin is hardcoded and never derived from
 * `window.location`.
 */
export function buildCanonicalUrl(type: LabelEntityType, routeId: string): string {
  const id = encodeURIComponent(String(routeId ?? "").trim());
  if (!id) throw new Error("A route id is required to build a canonical label URL.");
  switch (type) {
    case "location":
      return `${CANONICAL_BASE_URL}/location/${id}`;
    case "asset":
      return `${CANONICAL_BASE_URL}/a/${id}`;
    case "item":
    case "entity":
      return `${CANONICAL_BASE_URL}/item/${id}`;
    default:
      throw new Error(`Unexpected label entity type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Text fitting primitives
// ---------------------------------------------------------------------------

export function sansFont(px: number, weight: "bold" | "normal" = "bold"): string {
  return `${weight} ${px}px ${LABEL_SANS_STACK}`;
}

export function monoFont(px: number, weight: "bold" | "normal" = "normal"): string {
  return `${weight} ${px}px ${LABEL_MONO_STACK}`;
}

/**
 * Breadcrumb width including SVG `letter-spacing`, which `measureText` ignores.
 * Spacing is counted for every glyph (not gaps) so the estimate stays conservative.
 */
function measureBreadcrumb(text: string, px: number, measure: TextMeasurer): number {
  return measure(text, sansFont(px)) + BREADCRUMB_LETTER_SPACING * text.length;
}

export function truncateWithEllipsis(text: string, cssFont: string, maxWidth: number, measure: TextMeasurer): string {
  if (measure(text, cssFont) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0) {
    truncated = truncated.slice(0, -1);
    const candidate = `${truncated.trim()}…`;
    if (measure(candidate, cssFont) <= maxWidth) return candidate;
  }
  return text;
}

/** Greedy word wrap with character-level hard wrapping for single over-wide words. */
export function wrapTextLines(
  text: string,
  cssFont: string,
  maxWidth: number,
  maxLines: number,
  measure: TextMeasurer
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const testLine = currentLine ? `${currentLine} ${word}` : word;

    if (measure(testLine, cssFont) <= maxWidth) {
      currentLine = testLine;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      // A single word wider than the column: hard wrap on characters.
      let chunk = "";
      for (const char of word) {
        if (measure(chunk + char, cssFont) <= maxWidth) {
          chunk += char;
        } else {
          if (chunk) lines.push(chunk);
          chunk = char;
        }
      }
      currentLine = chunk;
    }

    if (lines.length === maxLines - 1) {
      const remaining = [currentLine, ...words.slice(i + 1)].filter(Boolean).join(" ");
      lines.push(truncateWithEllipsis(remaining, cssFont, maxWidth, measure));
      currentLine = "";
      break;
    }
  }

  if (currentLine && lines.length < maxLines) lines.push(currentLine);
  return lines.length > 0 ? lines : [""];
}

/**
 * Collapses an ancestry trail to the header breadcrumb. Deep hierarchies
 * degrade to `ROOT > … > PARENT` so the 168 px header row cannot be clipped.
 */
export function collapseBreadcrumb(ancestors: string[], fallback: string): string {
  const parts = (ancestors ?? []).map(p => String(p ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return fallback.toUpperCase();
  if (parts.length <= 2) return parts.join(" > ").toUpperCase();
  return `${parts[0]} > … > ${parts[parts.length - 1]}`.toUpperCase();
}

/** Steps the breadcrumb down 11pt -> 10pt -> 9pt, then truncates with an ellipsis. */
export function fitBreadcrumb(text: string, measure: TextMeasurer): { text: string; fontPx: number } {
  let fontPx = ptToPx(BREADCRUMB_PT_TIERS[BREADCRUMB_PT_TIERS.length - 1]);
  for (const pt of BREADCRUMB_PT_TIERS) {
    fontPx = ptToPx(pt);
    if (measureBreadcrumb(text, fontPx, measure) <= BREADCRUMB_MAX_WIDTH) {
      return { text, fontPx };
    }
  }
  // Account for letter-spacing by shrinking the budget before ellipsizing.
  const budget = BREADCRUMB_MAX_WIDTH - BREADCRUMB_LETTER_SPACING * Math.max(text.length, 1);
  return {
    text: truncateWithEllipsis(text, sansFont(fontPx), Math.max(budget, 0), measure),
    fontPx,
  };
}

/**
 * Sizes the footer row so the id prefix and the domain badge cannot collide.
 * Both share the 208 px column: the font steps down first, then the id is
 * ellipsized, because the domain badge is the part a human reads off the label.
 */
export function fitFooter(
  shortId: string,
  domain: string,
  measure: TextMeasurer
): { shortId: string; domain: string; fontPx: number } {
  const gap = 8;
  for (const pt of FOOTER_PT_TIERS) {
    const fontPx = ptToPx(pt);
    const idWidth = shortId ? measure(shortId, monoFont(fontPx, "bold")) : 0;
    const domainWidth = measure(domain, monoFont(fontPx));
    if (idWidth + (shortId ? gap : 0) + domainWidth <= TITLE_MAX_WIDTH) {
      return { shortId, domain, fontPx };
    }
  }

  const fontPx = ptToPx(FOOTER_PT_TIERS[FOOTER_PT_TIERS.length - 1]);
  const domainWidth = measure(domain, monoFont(fontPx));
  const budget = TITLE_MAX_WIDTH - domainWidth - gap;
  return {
    shortId: budget > 0 ? truncateWithEllipsis(shortId, monoFont(fontPx, "bold"), budget, measure) : "",
    domain,
    fontPx,
  };
}

/**
 * Picks the largest title tier that fits without truncation, then wraps.
 * Falls back to 16pt over three lines with graceful truncation.
 */
export function layoutTitle(
  title: string,
  measure: TextMeasurer
): { lines: string[]; fontPx: number; baselines: number[] } {
  const clean = (title ?? "").trim() || "Untitled";

  const fitsCleanly = (px: number, maxLines: number): boolean => {
    const font = sansFont(px);
    const words = clean.split(/\s+/).filter(Boolean);
    let lineCount = 1;
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (measure(test, font) <= TITLE_MAX_WIDTH) {
        current = test;
      } else {
        lineCount++;
        current = word;
        if (measure(word, font) > TITLE_MAX_WIDTH) return false;
      }
    }
    return lineCount <= maxLines;
  };

  let chosen = TITLE_TIERS[TITLE_TIERS.length - 1];
  for (const tier of TITLE_TIERS) {
    if (fitsCleanly(ptToPx(tier.pt), tier.maxLines)) {
      chosen = tier;
      break;
    }
  }

  const fontPx = ptToPx(chosen.pt);
  const lines = wrapTextLines(clean, sansFont(fontPx), TITLE_MAX_WIDTH, chosen.maxLines, measure);

  // Title box spans Y 64..188; baselines mirror the CLI reference engine.
  const baselines: number[] = [];
  if (lines.length === 1) {
    baselines.push(134);
  } else if (lines.length === 2) {
    const lineHeight = Math.round(fontPx * 1.25);
    baselines.push(112, 112 + lineHeight);
  } else {
    const lineHeight = Math.round(fontPx * 1.18);
    baselines.push(96, 96 + lineHeight, 96 + lineHeight * 2);
  }

  return { lines, fontPx, baselines };
}

// ---------------------------------------------------------------------------
// 4. Layout assembly
// ---------------------------------------------------------------------------

/**
 * Resolves a complete, deterministic label layout. Nothing here touches the
 * DOM beyond the injected `measure` callback.
 */
export function computeLabelLayout(spec: LabelSpec, measure: TextMeasurer): LabelLayout {
  const url = buildCanonicalUrl(spec.type, spec.routeId);
  const isLocation = spec.type === "location";

  // Version 5 (37 x 37) is the ADR 0026 target and yields exactly 4 px modules.
  // Longer payloads step up a version; the module size then shrinks to the
  // largest integer that still fits the 148 px box, preserving crisp edges.
  const qr = generateQrMatrix(url, { ecl: "M", minVersion: 5 });
  const qrModulePx = Math.max(1, Math.floor(QR_BOX_PX / qr.size));
  const rendered = qr.size * qrModulePx;
  const qrOffsetX = QR_ORIGIN_X + Math.floor((QR_BOX_PX - rendered) / 2);
  const qrOffsetY = QR_ORIGIN_Y + Math.floor((QR_BOX_PX - rendered) / 2);

  const iconSlug = resolveIcon(spec.title, spec.description ?? "", spec.icon ?? null, isLocation);

  const breadcrumbText = collapseBreadcrumb(spec.ancestors ?? [], isLocation ? "STORAGE" : "ITEM");
  const breadcrumb = fitBreadcrumb(breadcrumbText, measure);

  const title = layoutTitle(spec.title, measure);

  // An asset label carries the asset id as its route, so fall back to it when
  // the caller has no separate UUID to print.
  const rawId = (spec.entityId || spec.routeId || "").trim();
  const footer = fitFooter(rawId ? `ID: ${rawId.length >= 8 ? rawId.slice(0, 8) : rawId}` : "", DOMAIN_BADGE, measure);

  return {
    qr,
    qrModulePx,
    qrOffsetX,
    qrOffsetY,
    iconSlug,
    iconPath: getIconPath(iconSlug),
    breadcrumb: breadcrumb.text,
    breadcrumbFontPx: breadcrumb.fontPx,
    titleLines: title.lines,
    titleFontPx: title.fontPx,
    titleBaselines: title.baselines,
    shortId: footer.shortId,
    domain: footer.domain,
    footerFontPx: footer.fontPx,
    url,
  };
}

// ---------------------------------------------------------------------------
// 5. SVG assembly
// ---------------------------------------------------------------------------

export function escapeXml(unsafe: string): string {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Emits the 400 x 240 SVG. Every vector (QR modules, MDI glyph) is inlined:
 * an SVG referencing an external resource taints the canvas it is drawn into
 * and would make `getImageData` throw.
 */
export function buildLabelSvg(layout: LabelLayout): string {
  let qrPath = "";
  const m = layout.qrModulePx;
  for (let r = 0; r < layout.qr.size; r++) {
    for (let c = 0; c < layout.qr.size; c++) {
      if (layout.qr.modules[r][c]) {
        const x = layout.qrOffsetX + c * m;
        const y = layout.qrOffsetY + r * m;
        qrPath += `M${x},${y}h${m}v${m}h-${m}z `;
      }
    }
  }

  const iconScale = ICON_SIZE_PX / 24;

  let titleSvg = "";
  for (let i = 0; i < layout.titleLines.length; i++) {
    titleSvg +=
      `  <text x="${TITLE_X}" y="${layout.titleBaselines[i]}" clip-path="url(#nelko-title-clip)" font-family='${LABEL_SANS_STACK}' ` +
      `font-size="${layout.titleFontPx}px" font-weight="bold" fill="#000000">` +
      `${escapeXml(layout.titleLines[i])}</text>\n`;
  }

  const footerPx = layout.footerFontPx;
  // Split the footer row between the id and the domain so neither can paint
  // over the other, whatever the client's monospace face turns out to be.
  const footerIdWidth = layout.shortId ? Math.round((RIGHT_EDGE_X - TITLE_X) * 0.46) : 0;
  const idSvg = layout.shortId
    ? `  <text x="${TITLE_X}" y="${FOOTER_BASELINE_Y}" clip-path="url(#nelko-footer-id-clip)" font-family='${LABEL_MONO_STACK}' font-size="${footerPx}px" font-weight="bold" fill="#000000">${escapeXml(layout.shortId)}</text>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${LABEL_WIDTH} ${LABEL_HEIGHT}">
  <!-- 50mm x 30mm @ 203 DPI pure 1-bit canvas -->
  <rect width="${LABEL_WIDTH}" height="${LABEL_HEIGHT}" fill="#FFFFFF"/>

  <!-- Left column: ${layout.qr.size} x ${layout.qr.size} QR matrix at ${m} px/module -->
  <path fill="#000000" d="${qrPath.trim()}"/>

  <!-- Right column header: ${ICON_SIZE_PX} x ${ICON_SIZE_PX} MDI category glyph (${escapeXml(layout.iconSlug)}) -->
  <g transform="translate(${ICON_ORIGIN_X}, ${ICON_ORIGIN_Y}) scale(${iconScale})">
    <path fill="#000000" d="${layout.iconPath}"/>
  </g>

  <!-- Clip paths are a hard guarantee: measurement drives the layout, but a
       client whose system font is wider than measured still cannot bleed text
       into the QR column or off the label edge. -->
  <defs>
    <clipPath id="nelko-breadcrumb-clip">
      <rect x="${BREADCRUMB_X}" y="${ICON_ORIGIN_Y}" width="${RIGHT_EDGE_X - BREADCRUMB_X}" height="34"/>
    </clipPath>
    <clipPath id="nelko-title-clip">
      <rect x="${TITLE_X}" y="60" width="${RIGHT_EDGE_X - TITLE_X}" height="${HAIRLINE_Y - 62}"/>
    </clipPath>
    <clipPath id="nelko-footer-id-clip">
      <rect x="${TITLE_X}" y="${HAIRLINE_Y + 2}" width="${footerIdWidth}" height="${LABEL_HEIGHT - HAIRLINE_Y - 4}"/>
    </clipPath>
    <clipPath id="nelko-footer-domain-clip">
      <rect x="${TITLE_X + footerIdWidth}" y="${HAIRLINE_Y + 2}" width="${RIGHT_EDGE_X - TITLE_X - footerIdWidth}" height="${LABEL_HEIGHT - HAIRLINE_Y - 4}"/>
    </clipPath>
  </defs>

  <!-- Right column header: parent breadcrumb -->
  <text x="${BREADCRUMB_X}" y="${BREADCRUMB_BASELINE_Y}" clip-path="url(#nelko-breadcrumb-clip)" font-family='${LABEL_SANS_STACK}' font-size="${layout.breadcrumbFontPx}px" font-weight="bold" fill="#000000" letter-spacing="${BREADCRUMB_LETTER_SPACING}">${escapeXml(layout.breadcrumb)}</text>

  <!-- Right column centre: auto-scaled title -->
${titleSvg}
  <!-- Right column footer: 1 px hairline divider -->
  <line x1="${TITLE_X}" y1="${HAIRLINE_Y}" x2="${RIGHT_EDGE_X}" y2="${HAIRLINE_Y}" stroke="#000000" stroke-width="1"/>

  <!-- Right column footer: UUID prefix and sovereign domain badge -->
${idSvg}  <text x="${RIGHT_EDGE_X}" y="${FOOTER_BASELINE_Y}" clip-path="url(#nelko-footer-domain-clip)" text-anchor="end" font-family='${LABEL_MONO_STACK}' font-size="${footerPx}px" fill="#000000">${escapeXml(layout.domain)}</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// 6. Luminance binarization
// ---------------------------------------------------------------------------

/** ITU-R BT.601 luma. Anything below 128 becomes ink. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Collapses an RGBA buffer to pure black or pure white in place, erasing the
 * anti-aliased greys that a thermal head would dither into a smear.
 * Transparent pixels resolve to white: the label stock is the background.
 */
export function binarizeImageData(data: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    // Composite over white before thresholding.
    const r = data[i] * alpha + 255 * (1 - alpha);
    const g = data[i + 1] * alpha + 255 * (1 - alpha);
    const b = data[i + 2] * alpha + 255 * (1 - alpha);
    // Rounded before comparing: the BT.601 coefficients do not sum to exactly
    // 1.0 in binary floating point, which would otherwise push a neutral 128
    // grey a fraction below the threshold and turn it into ink.
    const value = Math.round(luminance(r, g, b)) < 128 ? 0 : 255;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  return data;
}

/** Extracts a 1-bit plane (1 = white paper, 0 = ink) from a binarized RGBA buffer. */
export function toBitPlane(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const plane = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    plane[p] = data[p * 4] < 128 ? 0 : 1;
  }
  return plane;
}

// ---------------------------------------------------------------------------
// 7. 1-bit greyscale PNG encoder (bit depth 1, colour type 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Zlib stream built from stored (uncompressed) deflate blocks. Always available. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const blockCount = Math.max(1, Math.ceil(raw.length / maxBlock));
  const out = new Uint8Array(2 + blockCount * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; // CM = 8 (deflate), CINFO = 7 (32K window)
  out[o++] = 0x01; // FCHECK, no preset dictionary, fastest level
  for (let offset = 0; offset < raw.length || offset === 0; offset += maxBlock) {
    const size = Math.min(maxBlock, raw.length - offset);
    const isFinal = offset + size >= raw.length;
    out[o++] = isFinal ? 1 : 0;
    out[o++] = size & 0xff;
    out[o++] = (size >> 8) & 0xff;
    out[o++] = ~size & 0xff;
    out[o++] = (~size >> 8) & 0xff;
    out.set(raw.subarray(offset, offset + size), o);
    o += size;
    if (isFinal) break;
  }
  const checksum = adler32(raw);
  out[o++] = (checksum >>> 24) & 0xff;
  out[o++] = (checksum >>> 16) & 0xff;
  out[o++] = (checksum >>> 8) & 0xff;
  out[o++] = checksum & 0xff;
  return out.subarray(0, o);
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return zlibStored(raw);
  try {
    const stream = new CS("deflate");
    const writer = stream.writable.getWriter();
    void writer.write(raw);
    void writer.close();
    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  } catch {
    return zlibStored(raw);
  }
}

/**
 * Packs a bit plane into a genuine 1 bit-per-pixel greyscale PNG, matching the
 * CLI reference engine's output format byte for byte in structure.
 *
 * @param plane One byte per pixel: 1 = white, 0 = black.
 */
export async function encode1BitPng(plane: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const rowBytes = Math.ceil(width / 8);
  const raw = new Uint8Array(height * (1 + rowBytes));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + rowBytes);
    raw[rowOffset] = 0; // filter type: none
    const planeOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (plane[planeOffset + x] === 1) {
        raw[rowOffset + 1 + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await zlibDeflate(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}

// ---------------------------------------------------------------------------
// 8. DOM layer
// ---------------------------------------------------------------------------

let measureContext: CanvasRenderingContext2D | null = null;

/** Shared offscreen 2D context used purely for text metrics. */
export function createCanvasMeasurer(): TextMeasurer {
  return (text: string, cssFont: string) => {
    if (!measureContext) {
      const canvas = document.createElement("canvas");
      canvas.width = LABEL_WIDTH;
      canvas.height = LABEL_HEIGHT;
      measureContext = canvas.getContext("2d");
    }
    if (!measureContext) return text.length * 8;
    measureContext.font = cssFont;
    return measureContext.measureText(text).width;
  };
}

export function svgToBlob(svg: string): Blob {
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

/** Loads an SVG string through an `<img>` element without touching the network. */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(svgToBlob(svg));
    const img = new Image();
    img.decoding = "sync";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to rasterize the label SVG."));
    };
    img.src = url;
  });
}

export interface RasterResult {
  /** Binarized RGBA buffer, already painted back onto the target canvas. */
  imageData: ImageData;
  /** One byte per pixel: 1 = white, 0 = ink. */
  plane: Uint8Array;
}

/**
 * Rasterizes the SVG into `canvas` at exactly 400 x 240, binarizes in place and
 * paints the result back, so the on-screen preview is the downloaded artwork.
 */
export async function renderLabelToCanvas(canvas: HTMLCanvasElement, svg: string): Promise<RasterResult> {
  canvas.width = LABEL_WIDTH;
  canvas.height = LABEL_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable.");

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);

  const img = await loadSvgImage(svg);
  ctx.drawImage(img, 0, 0, LABEL_WIDTH, LABEL_HEIGHT);

  const imageData = ctx.getImageData(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  binarizeImageData(imageData.data);
  ctx.putImageData(imageData, 0, 0);

  return { imageData, plane: toBitPlane(imageData.data, LABEL_WIDTH, LABEL_HEIGHT) };
}

/** Full pipeline: SVG -> canvas -> luminance threshold -> 1-bit PNG blob. */
export async function renderMonochromePng(svg: string, canvas?: HTMLCanvasElement): Promise<Blob> {
  const target = canvas ?? document.createElement("canvas");
  const { plane } = await renderLabelToCanvas(target, svg);
  const png = await encode1BitPng(plane, LABEL_WIDTH, LABEL_HEIGHT);
  return new Blob([png as unknown as BlobPart], { type: "image/png" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Convenience wrapper: spec -> `{ layout, svg }` using DOM text metrics. */
export function renderLabel(
  spec: LabelSpec,
  measure: TextMeasurer = createCanvasMeasurer()
): {
  layout: LabelLayout;
  svg: string;
} {
  const layout = computeLabelLayout(spec, measure);
  return { layout, svg: buildLabelSvg(layout) };
}
