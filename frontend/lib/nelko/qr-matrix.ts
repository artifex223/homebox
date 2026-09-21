/**
 * frontend/lib/nelko/qr-matrix.ts
 *
 * Deterministic, zero-dependency QR Code (Model 2) matrix engine.
 * Generates ISO/IEC 18004 compliant 2D boolean matrices in the browser.
 *
 * Ported verbatim (semantics preserved) from the Node reference engine at
 * `secondbrain/scripts/lib/qr-matrix.js` so that a label rendered client-side
 * is byte-identical to one produced by the CLI generator. See ADR 0026.
 */

export type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  /** QR symbol version, 1..40. Version 5 yields the 37x37 matrix ADR 0026 expects. */
  version: number;
  /** Module count per side (21 + 4 * (version - 1)). */
  size: number;
  /** Row-major dark-module grid; `true` is a dark (ink) module. */
  modules: boolean[][];
}

export interface QrMatrixOptions {
  ecl?: ErrorCorrectionLevel;
  minVersion?: number;
  maxVersion?: number;
}

interface EcLevelSpec {
  ordinal: number;
  formatBits: number;
}

// Error Correction Levels
const EC_LEVELS: Record<ErrorCorrectionLevel, EcLevelSpec> = {
  L: { ordinal: 0, formatBits: 0x01 }, // 7% recovery
  M: { ordinal: 1, formatBits: 0x00 }, // 15% recovery
  Q: { ordinal: 2, formatBits: 0x03 }, // 25% recovery
  H: { ordinal: 3, formatBits: 0x02 }, // 30% recovery
};

// Alignment pattern center locations by version (1 to 40)
const ALIGNMENT_PATTERN_TABLE: number[][] = [
  [], // V1
  [6, 18], // V2
  [6, 22],
  [6, 26],
  [6, 30], // V5 (37x37)
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50], // V10
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90], // V20
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130], // V30
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170], // V40
];

// EC Codewords and block specs per version and EC level:
// [ecCodewordsPerBlock, numBlocksG1, dataCodewordsG1, numBlocksG2, dataCodewordsG2]
const EC_SPECS: Record<ErrorCorrectionLevel, number[][]> = {
  L: [
    [],
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0],
    [30, 3, 115, 1, 116],
    [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99],
    [28, 1, 107, 5, 108],
    [30, 5, 120, 1, 121],
    [28, 3, 113, 4, 114],
    [28, 3, 107, 5, 108],
    [28, 4, 116, 4, 117],
    [28, 2, 111, 7, 112],
    [30, 4, 121, 5, 122],
    [30, 6, 117, 4, 118],
    [26, 8, 106, 4, 107],
    [28, 10, 114, 2, 115],
    [30, 8, 122, 4, 123],
    [30, 3, 117, 10, 118],
    [30, 7, 116, 7, 117],
    [30, 5, 115, 10, 116],
    [30, 13, 115, 3, 116],
    [30, 17, 115, 0, 0],
    [30, 17, 115, 1, 116],
    [30, 13, 115, 6, 116],
    [30, 12, 121, 7, 122],
    [30, 6, 121, 14, 122],
    [30, 17, 122, 4, 123],
    [30, 4, 122, 18, 123],
    [30, 20, 117, 4, 118],
    [30, 19, 118, 6, 119],
  ],
  M: [
    [],
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38],
    [24, 4, 40, 5, 41],
    [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46],
    [28, 10, 46, 1, 47],
    [26, 9, 43, 4, 44],
    [26, 3, 44, 11, 45],
    [26, 3, 41, 13, 42],
    [26, 17, 42, 0, 0],
    [28, 17, 46, 0, 0],
    [28, 4, 47, 14, 48],
    [28, 6, 45, 14, 46],
    [28, 8, 47, 13, 48],
    [28, 19, 46, 4, 47],
    [28, 22, 45, 3, 46],
    [28, 3, 45, 23, 46],
    [28, 21, 45, 7, 46],
    [28, 19, 47, 10, 48],
    [28, 2, 46, 29, 47],
    [28, 10, 46, 23, 47],
    [28, 14, 46, 21, 47],
    [28, 14, 46, 23, 47],
    [28, 12, 47, 26, 48],
    [28, 6, 47, 34, 48],
    [28, 29, 46, 14, 47],
    [28, 13, 46, 32, 47],
    [28, 40, 47, 7, 48],
    [28, 18, 47, 31, 48],
  ],
  Q: [
    [],
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
    [28, 4, 22, 4, 23],
    [26, 4, 20, 6, 21],
    [24, 8, 20, 4, 21],
    [20, 11, 16, 5, 17],
    [30, 5, 24, 7, 25],
    [24, 15, 19, 2, 20],
    [28, 3, 22, 11, 23],
    [28, 17, 22, 2, 23],
    [26, 17, 21, 4, 22],
    [30, 15, 24, 5, 25],
    [28, 17, 22, 6, 23],
    [30, 7, 24, 16, 25],
    [30, 11, 24, 14, 25],
    [30, 11, 24, 16, 25],
    [30, 7, 24, 22, 25],
    [30, 28, 24, 0, 0],
    [30, 8, 25, 26, 26],
    [30, 4, 24, 31, 25],
    [30, 1, 23, 37, 24],
    [30, 15, 24, 25, 25],
    [30, 42, 24, 1, 25],
    [30, 10, 24, 35, 25],
    [30, 29, 24, 19, 25],
    [30, 44, 24, 7, 25],
    [30, 39, 24, 14, 25],
    [30, 46, 24, 10, 25],
    [30, 49, 24, 10, 25],
    [30, 48, 24, 14, 25],
    [30, 43, 24, 22, 25],
    [30, 34, 24, 34, 25],
  ],
  H: [
    [],
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
    [24, 3, 13, 8, 14],
    [28, 7, 14, 4, 15],
    [22, 12, 11, 4, 12],
    [24, 11, 12, 5, 13],
    [24, 11, 12, 7, 13],
    [30, 3, 15, 13, 16],
    [28, 2, 14, 17, 15],
    [28, 2, 14, 19, 15],
    [26, 9, 13, 16, 14],
    [28, 15, 15, 10, 16],
    [30, 19, 16, 6, 17],
    [30, 34, 15, 0, 0],
    [30, 16, 15, 14, 16],
    [30, 30, 16, 2, 17],
    [30, 22, 15, 13, 16],
    [30, 33, 16, 4, 17],
    [30, 12, 15, 28, 16],
    [30, 11, 15, 31, 16],
    [30, 19, 15, 26, 16],
    [30, 23, 15, 25, 16],
    [30, 23, 15, 28, 16],
    [30, 19, 15, 35, 16],
    [30, 11, 15, 46, 16],
    [30, 59, 16, 1, 17],
    [30, 22, 15, 41, 16],
    [30, 2, 15, 64, 16],
    [30, 24, 15, 46, 16],
    [30, 42, 15, 32, 16],
    [30, 10, 15, 67, 16],
    [30, 20, 15, 61, 16],
  ],
};

// Galois Field GF(256) math
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d; // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
    }
  }
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }
})();

function gfMultiply(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
}

// Reed-Solomon generator polynomial
const RS_GENERATORS: Record<number, number[]> = {};
function getRsGenerator(degree: number): number[] {
  if (RS_GENERATORS[degree]) return RS_GENERATORS[degree];
  let poly: number[] = [1];
  for (let i = 0; i < degree; i++) {
    const factor = [1, EXP_TABLE[i]];
    const nextPoly = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      nextPoly[j] ^= gfMultiply(poly[j], factor[0]);
      nextPoly[j + 1] ^= gfMultiply(poly[j], factor[1]);
    }
    poly = Array.from(nextPoly);
  }
  RS_GENERATORS[degree] = poly;
  return poly;
}

function computeReedSolomon(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = getRsGenerator(ecCount);
  const remainder = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    for (let j = 0; j < ecCount - 1; j++) {
      remainder[j] = remainder[j + 1] ^ gfMultiply(generator[j + 1], factor);
    }
    remainder[ecCount - 1] = gfMultiply(generator[ecCount], factor);
  }
  return remainder;
}

// Format info bit constants (15 bits with BCH code masked by 0x5412)
function getFormatBits(ecl: ErrorCorrectionLevel, maskPattern: number): number {
  const data = (EC_LEVELS[ecl].formatBits << 3) | maskPattern;
  let bch = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((bch >> i) & 1) {
      bch ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | bch) ^ 0x5412;
}

// Version info bit constants (18 bits with BCH code for V >= 7)
function getVersionBits(version: number): number {
  let bch = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((bch >> i) & 1) {
      bch ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | bch;
}

function getDataCapacity(version: number, ecl: ErrorCorrectionLevel): number {
  const spec = EC_SPECS[ecl][version];
  return spec[1] * spec[2] + spec[3] * spec[4];
}

function selectMinVersion(byteCount: number, ecl: ErrorCorrectionLevel, minV = 1, maxV = 40): number {
  for (let v = minV; v <= maxV; v++) {
    const charCountBits = v < 10 ? 8 : 16;
    const headerBits = 4 + charCountBits;
    const totalDataBits = headerBits + byteCount * 8;
    const capacityBytes = getDataCapacity(v, ecl);
    if (Math.ceil(totalDataBits / 8) <= capacityBytes) {
      return v;
    }
  }
  throw new Error(`Data payload too large for QR Code Level ${ecl} up to Version ${maxV}`);
}

/**
 * Generates the 2D QR Code matrix for `text`.
 *
 * @param text Payload to encode, always 8-bit byte mode (UTF-8).
 * @param options Error correction level and version clamps.
 */
export function generateQrMatrix(text: string, options: QrMatrixOptions = {}): QrMatrix {
  const ecl = (options.ecl || "M").toUpperCase() as ErrorCorrectionLevel;
  if (!EC_LEVELS[ecl]) throw new Error(`Invalid error correction level: ${ecl}`);
  const minV = options.minVersion || 1;
  const maxV = options.maxVersion || 40;

  const rawBytes = new TextEncoder().encode(text);
  const version = selectMinVersion(rawBytes.length, ecl, minV, maxV);
  const size = 21 + 4 * (version - 1);

  // Bit buffer encoding (Byte Mode: 0100)
  const bitBuffer: number[] = [];
  function pushBits(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      bitBuffer.push((val >> i) & 1);
    }
  }

  // Mode Indicator (0100 = 8-bit byte mode)
  pushBits(0b0100, 4);

  // Character Count Indicator
  const charCountBits = version < 10 ? 8 : 16;
  pushBits(rawBytes.length, charCountBits);

  // Payload bytes
  for (let i = 0; i < rawBytes.length; i++) {
    pushBits(rawBytes[i], 8);
  }

  const totalDataBytes = getDataCapacity(version, ecl);
  const totalDataBits = totalDataBytes * 8;

  // Terminator (up to 4 zeroes)
  const termBits = Math.min(4, totalDataBits - bitBuffer.length);
  pushBits(0, termBits);

  // Pad to byte boundary
  while (bitBuffer.length % 8 !== 0) {
    bitBuffer.push(0);
  }

  // Pad bytes (0xEC, 0x11)
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bitBuffer.length < totalDataBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to byte codewords
  const dataBytes = new Uint8Array(totalDataBytes);
  for (let i = 0; i < totalDataBytes; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bitBuffer[i * 8 + j];
    }
    dataBytes[i] = b;
  }

  // Split into blocks and calculate Reed-Solomon EC
  const spec = EC_SPECS[ecl][version];
  const ecCodewordsPerBlock = spec[0];
  const numBlocksG1 = spec[1];
  const dataCodewordsG1 = spec[2];
  const numBlocksG2 = spec[3];
  const dataCodewordsG2 = spec[4];
  const totalBlocks = numBlocksG1 + numBlocksG2;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let byteOffset = 0;

  for (let b = 0; b < totalBlocks; b++) {
    const isG1 = b < numBlocksG1;
    const blockSize = isG1 ? dataCodewordsG1 : dataCodewordsG2;
    const blockData = dataBytes.subarray(byteOffset, byteOffset + blockSize);
    byteOffset += blockSize;
    dataBlocks.push(blockData);
    ecBlocks.push(computeReedSolomon(blockData, ecCodewordsPerBlock));
  }

  // Interleave data codewords
  const finalCodewords: number[] = [];
  const maxDataCodewords = Math.max(dataCodewordsG1, dataCodewordsG2);
  for (let i = 0; i < maxDataCodewords; i++) {
    for (let b = 0; b < totalBlocks; b++) {
      if (i < dataBlocks[b].length) {
        finalCodewords.push(dataBlocks[b][i]);
      }
    }
  }

  // Interleave EC codewords
  for (let i = 0; i < ecCodewordsPerBlock; i++) {
    for (let b = 0; b < totalBlocks; b++) {
      finalCodewords.push(ecBlocks[b][i]);
    }
  }

  // Setup Matrix.
  // modules: true for dark, false for light, null for unassigned.
  // isFunction: true if the module is reserved for a function pattern.
  const modules: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  function setFunctionModule(r: number, c: number, isDark: boolean) {
    modules[r][c] = isDark;
    isFunction[r][c] = true;
  }

  // Finder Patterns
  function drawFinderPattern(r0: number, c0: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = r0 + r;
        const nc = c0 + c;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
          const isDark =
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setFunctionModule(nr, nc, isDark);
        }
      }
    }
  }
  drawFinderPattern(0, 0);
  drawFinderPattern(0, size - 7);
  drawFinderPattern(size - 7, 0);

  // Alignment Patterns
  const alignCoords = ALIGNMENT_PATTERN_TABLE[version - 1];
  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      const ar = alignCoords[i];
      const ac = alignCoords[j];
      // Skip if overlapping finder patterns
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 8) || (ar >= size - 8 && ac <= 8)) {
        continue;
      }
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const isDark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFunctionModule(ar + r, ac + c, isDark);
        }
      }
    }
  }

  // Timing Patterns
  for (let i = 8; i < size - 8; i++) {
    if (!isFunction[6][i]) setFunctionModule(6, i, i % 2 === 0);
    if (!isFunction[i][6]) setFunctionModule(i, 6, i % 2 === 0);
  }

  // Dark module (always at row 4*V + 9, col 8)
  setFunctionModule(4 * version + 9, 8, true);

  // Reserve Format Info areas
  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }
  for (let i = size - 8; i < size; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }

  // Reserve Version Info areas (V >= 7)
  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = size - 11; c < size - 8; c++) {
        isFunction[r][c] = true;
      }
    }
    for (let r = size - 11; r < size - 8; r++) {
      for (let c = 0; c < 6; c++) {
        isFunction[r][c] = true;
      }
    }
  }

  // Data Placement
  const dataBits: number[] = [];
  for (const byte of finalCodewords) {
    for (let i = 7; i >= 0; i--) {
      dataBits.push((byte >> i) & 1);
    }
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip vertical timing column
    const cols = [right, right - 1];
    const rows: number[] = [];
    if (upward) {
      for (let r = size - 1; r >= 0; r--) rows.push(r);
    } else {
      for (let r = 0; r < size; r++) rows.push(r);
    }
    for (const r of rows) {
      for (const c of cols) {
        if (!isFunction[r][c]) {
          modules[r][c] = bitIdx < dataBits.length ? dataBits[bitIdx++] === 1 : false;
        }
      }
    }
    upward = !upward;
  }

  // Masking functions
  const MASK_FNS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    r => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  // Helper to evaluate penalty for a masked matrix
  function evaluatePenalty(grid: boolean[][]): number {
    let penalty = 0;
    // Rule 1: 5 or more same color in a row/column
    for (let r = 0; r < size; r++) {
      let count = 0;
      let last: boolean | null = null;
      for (let c = 0; c < size; c++) {
        if (grid[r][c] === last) {
          count++;
          if (count === 5) penalty += 3;
          else if (count > 5) penalty += 1;
        } else {
          last = grid[r][c];
          count = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let count = 0;
      let last: boolean | null = null;
      for (let r = 0; r < size; r++) {
        if (grid[r][c] === last) {
          count++;
          if (count === 5) penalty += 3;
          else if (count > 5) penalty += 1;
        } else {
          last = grid[r][c];
          count = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks of same color
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const val = grid[r][c];
        if (val === grid[r + 1][c] && val === grid[r][c + 1] && val === grid[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }

    // Rule 3: 1:1:3:1:1 pattern (finder-like)
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size - 10; c++) {
        if (
          grid[r][c] &&
          !grid[r][c + 1] &&
          grid[r][c + 2] &&
          grid[r][c + 3] &&
          grid[r][c + 4] &&
          !grid[r][c + 5] &&
          grid[r][c + 6]
        ) {
          if (c >= 4 && !grid[r][c - 1] && !grid[r][c - 2] && !grid[r][c - 3] && !grid[r][c - 4]) {
            penalty += 40;
          } else if (c + 10 < size && !grid[r][c + 7] && !grid[r][c + 8] && !grid[r][c + 9] && !grid[r][c + 10]) {
            penalty += 40;
          }
        }
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size - 10; r++) {
        if (
          grid[r][c] &&
          !grid[r + 1][c] &&
          grid[r + 2][c] &&
          grid[r + 3][c] &&
          grid[r + 4][c] &&
          !grid[r + 5][c] &&
          grid[r + 6][c]
        ) {
          if (r >= 4 && !grid[r - 1][c] && !grid[r - 2][c] && !grid[r - 3][c] && !grid[r - 4][c]) {
            penalty += 40;
          } else if (r + 10 < size && !grid[r + 7][c] && !grid[r + 8][c] && !grid[r + 9][c] && !grid[r + 10][c]) {
            penalty += 40;
          }
        }
      }
    }

    // Rule 4: Proportion of dark modules
    let darkCount = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c]) darkCount++;
      }
    }
    const ratio = (darkCount * 100) / (size * size);
    const k = Math.floor(Math.abs(ratio - 50) / 5);
    penalty += k * 10;

    return penalty;
  }

  // Find optimal mask
  let minPenalty = Infinity;
  let bestGrid: boolean[][] | null = null;

  for (let m = 0; m < 8; m++) {
    const maskFn = MASK_FNS[m];
    const candidate: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (isFunction[r][c]) {
          candidate[r][c] = modules[r][c] === true;
        } else {
          candidate[r][c] = maskFn(r, c) ? !modules[r][c] : modules[r][c] === true;
        }
      }
    }

    // Write format info to candidate.
    // Coordinates are [row, column] indexed by format bit number, least
    // significant bit first, per ISO/IEC 18004 figure 25.
    const formatBits = getFormatBits(ecl, m);
    // Copy 1, wrapping the top-left finder pattern.
    const tlCoords = [
      [0, 8],
      [1, 8],
      [2, 8],
      [3, 8],
      [4, 8],
      [5, 8],
      [7, 8],
      [8, 8],
      [8, 7],
      [8, 5],
      [8, 4],
      [8, 3],
      [8, 2],
      [8, 1],
      [8, 0],
    ];
    for (let i = 0; i < 15; i++) {
      candidate[tlCoords[i][0]][tlCoords[i][1]] = ((formatBits >> i) & 1) === 1;
    }
    // Copy 2, split between the top-right and bottom-left finder patterns.
    const splitCoords = [
      [8, size - 1],
      [8, size - 2],
      [8, size - 3],
      [8, size - 4],
      [8, size - 5],
      [8, size - 6],
      [8, size - 7],
      [8, size - 8],
      [size - 7, 8],
      [size - 6, 8],
      [size - 5, 8],
      [size - 4, 8],
      [size - 3, 8],
      [size - 2, 8],
      [size - 1, 8],
    ];
    for (let i = 0; i < 15; i++) {
      candidate[splitCoords[i][0]][splitCoords[i][1]] = ((formatBits >> i) & 1) === 1;
    }

    // Write version info if V >= 7
    if (version >= 7) {
      const vBits = getVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((vBits >> i) & 1) === 1;
        const r = Math.floor(i / 3);
        const c = (i % 3) + size - 11;
        candidate[r][c] = bit;
        candidate[c][r] = bit;
      }
    }

    const penalty = evaluatePenalty(candidate);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestGrid = candidate;
    }
  }

  return {
    version,
    size,
    modules: bestGrid as boolean[][],
  };
}
