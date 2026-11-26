import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVANCE_UNIT,
  ATLAS_LAYOUT,
  ATLAS_MAGIC,
  ATLAS_VERSION,
  FALLBACK_CODE_POINT,
  SCRIPT_COMMON,
  parseAtlas,
} from "../src/label/atlas.mjs";
import {
  LABEL_HEIGHT,
  LABEL_LOGO_MAX_HEIGHT,
  LABEL_PAD,
  LABEL_TEXT_WIDTH,
  LABEL_WIDTH,
} from "../src/label/render.mjs";

const require = createRequire(import.meta.url);
const { createCanvas, loadImage, registerFont } = require("canvas");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GILL_FILE = path.join(ROOT, "fonts/GillSansMT_Bold.ttf");
const NOTO_FILE = path.join(ROOT, "fonts/NotoSansJP-Bold.ttf");
const LOGO_FILE = path.join(ROOT, "public/images/logo.png");
const OUTPUT_FILE = path.join(ROOT, "worker/src/label/atlas.bin");
const GILL = "Gill Sans MT";
const NOTO = "Noto Sans JP";
const NOTO_ALIAS = "Noto Sans JP Atlas";
const FONT_IDS = new Map([[GILL, 1], [NOTO, 2]]);
const PEN_X = 160;
const BASELINE = 220;
const CELL_SIZE = 320;
const GLYPH_MARGIN = 1;
const JIS_CELLS = 94;
const EUC_JP_ROW_OFFSET = 0xa0;
const JIS_NON_KANJI_ROWS = [1, 8];
const JIS_LEVEL_ONE_KANJI_ROWS = [16, 47];
const EXTRA_NOTO_CODE_POINTS = [0x0020, 0x00a0, 0x00a2, 0x00a3, 0x00a4, 0x00ac, 0x2016, 0x203e, 0x2212, 0x301c];
const NOTO_BOLD_MIN_LATIN_ADVANCE = 12.5;
const KANJI_KERN_SAMPLES = 4000;
const BASELINE_PROBES = ["K", "E", "H", "T", "L", "5", "0", "o", "x"];
const BASELINE_PROBE_X = 9;
const BASELINE_PROBE_BASELINE = 80;
const BASELINE_SHIFT_RANGE = [0.2, 0.9];
const SCRIPT_NAMES = ["Latin", "Greek", "Cyrillic", "Hiragana", "Katakana", "Han"];
const SCRIPT_RES = SCRIPT_NAMES.map((name) => new RegExp(`^\\p{Script=${name}}$`, "u"));
const GROUP_SPECS = [
  { font: GILL, px: 34, phases: 4, set: "gill", sets: 1, fallback: true },
  { font: GILL, px: 18, phases: 4, set: "gill", sets: 2, raises: true },
  { font: GILL, px: 20, phases: 4, set: "gill", sets: 2, raises: true },
  { font: NOTO, px: 18, phases: 1, set: "noto", sets: 2, raises: false },
  { font: NOTO, px: 20, phases: 2, set: "noto", sets: 2, raises: false },
];

function parseCmap(file) {
  const font = readFileSync(file);
  const tableCount = font.readUInt16BE(4);
  let tableOffset = -1;
  for (let i = 0; i < tableCount; i += 1) {
    const record = 12 + i * 16;
    if (font.toString("latin1", record, record + 4) === "cmap") tableOffset = font.readUInt32BE(record + 8);
  }
  const subtableCount = font.readUInt16BE(tableOffset + 2);
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < subtableCount; i += 1) {
    const record = tableOffset + 4 + i * 8;
    const platform = font.readUInt16BE(record);
    const encoding = font.readUInt16BE(record + 2);
    const score = platform === 3 && encoding === 10 ? 5 : platform === 0 ? 4 : platform === 3 && encoding === 1 ? 3 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = tableOffset + font.readUInt32BE(record + 4);
    }
  }
  const format = font.readUInt16BE(best);
  const codePoints = new Set();
  if (format === 12) {
    const groupCount = font.readUInt32BE(best + 12);
    for (let g = 0; g < groupCount; g += 1) {
      const record = best + 16 + g * 12;
      const start = font.readUInt32BE(record);
      const end = font.readUInt32BE(record + 4);
      const firstGlyph = font.readUInt32BE(record + 8);
      for (let cp = start; cp <= end; cp += 1) if (firstGlyph + cp - start !== 0) codePoints.add(cp);
    }
  } else if (format === 4) {
    const segmentCount = font.readUInt16BE(best + 6) / 2;
    const endOffset = best + 14;
    const startOffset = endOffset + segmentCount * 2 + 2;
    const deltaOffset = startOffset + segmentCount * 2;
    const rangeOffset = deltaOffset + segmentCount * 2;
    for (let s = 0; s < segmentCount; s += 1) {
      const end = font.readUInt16BE(endOffset + s * 2);
      const start = font.readUInt16BE(startOffset + s * 2);
      const delta = font.readInt16BE(deltaOffset + s * 2);
      const range = font.readUInt16BE(rangeOffset + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp += 1) {
        let glyph;
        if (range === 0) glyph = (cp + delta) & 0xffff;
        else {
          const index = range / 2 + (cp - start) - (segmentCount - s);
          glyph = font.readUInt16BE(rangeOffset + s * 2 + index * 2);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) codePoints.add(cp);
      }
    }
  } else throw new Error(`Unsupported cmap format ${format} in ${path.basename(file)}`);
  return codePoints;
}

function jisCodePoints(decoder, [firstRow, lastRow]) {
  const codePoints = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let cell = 1; cell <= JIS_CELLS; cell += 1) {
      const char = decoder.decode(Uint8Array.from([EUC_JP_ROW_OFFSET + row, EUC_JP_ROW_OFFSET + cell]));
      if (char.length === 1 && char !== "\ufffd") codePoints.push(char.codePointAt(0));
    }
  }
  return codePoints;
}

function scriptId(char) {
  for (let i = 0; i < SCRIPT_RES.length; i += 1) if (SCRIPT_RES[i].test(char)) return i + 1;
  return SCRIPT_COMMON;
}

function contextForFont(font) {
  const canvas = createCanvas(CELL_SIZE, CELL_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = "#000";
  return ctx;
}

function cropToInk(alpha, width, height) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (alpha[row * width + col] === 0) continue;
      if (col < left) left = col;
      if (col > right) right = col;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }
  }
  if (right < left) return null;
  const croppedWidth = right - left + 1;
  const bytes = new Uint8Array(croppedWidth * (bottom - top + 1));
  for (let row = top; row <= bottom; row += 1) {
    bytes.set(alpha.subarray(row * width + left, row * width + right + 1), (row - top) * croppedWidth);
  }
  return { left, top, width: croppedWidth, height: bottom - top + 1, bytes };
}

function rasterizeVariant(ctx, char, shift) {
  const metrics = ctx.measureText(char);
  const left = metrics.actualBoundingBoxLeft ?? 0;
  const right = metrics.actualBoundingBoxRight ?? metrics.width;
  const ascent = metrics.actualBoundingBoxAscent ?? 0;
  const descent = metrics.actualBoundingBoxDescent ?? 0;
  const baseline = BASELINE + shift.y;
  const boxLeft = Math.floor(PEN_X + shift.x - left) - GLYPH_MARGIN;
  const boxTop = Math.floor(baseline - ascent) - GLYPH_MARGIN;
  const boxWidth = Math.max(0, Math.ceil(PEN_X + shift.x + right) + GLYPH_MARGIN - boxLeft);
  const boxHeight = Math.max(0, Math.ceil(baseline + descent) + GLYPH_MARGIN - boxTop);
  if (boxWidth === 0 || boxHeight === 0) return { shape: { ox: 0, oy: 0, w: 0, h: 0 }, bytes: new Uint8Array(0) };
  ctx.clearRect(0, 0, CELL_SIZE, CELL_SIZE);
  ctx.fillText(char, PEN_X + shift.x, baseline);
  const data = ctx.getImageData(boxLeft, boxTop, boxWidth, boxHeight).data;
  const alpha = new Uint8Array(boxWidth * boxHeight);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3];
  const ink = cropToInk(alpha, boxWidth, boxHeight);
  if (!ink) return { shape: { ox: 0, oy: 0, w: 0, h: 0 }, bytes: new Uint8Array(0) };
  return { shape: { ox: boxLeft + ink.left - PEN_X, oy: boxTop + ink.top - BASELINE, w: ink.width, h: ink.height }, bytes: ink.bytes };
}

function rasterizeGlyph(ctx, codePoint, phases, sets, shift) {
  const char = String.fromCodePoint(codePoint);
  const entry = { codePoint, advance: Math.round(ctx.measureText(char).width * ADVANCE_UNIT), script: scriptId(char), variants: [], blobs: [] };
  for (let set = 0; set < sets; set += 1) {
    const y = set === 0 ? 0 : shift;
    for (let phase = 0; phase < phases; phase += 1) {
      const { shape, bytes } = rasterizeVariant(ctx, char, { x: phase / phases, y });
      entry.variants.push(shape);
      entry.blobs.push(bytes);
    }
  }
  return entry;
}

function measureKerning(ctx, chars, advances) {
  const pairs = [];
  for (let a = 0; a < chars.length; a += 1) {
    for (let b = 0; b < chars.length; b += 1) {
      const amount = Math.round((ctx.measureText(chars[a] + chars[b]).width - advances[a] - advances[b]) * ADVANCE_UNIT);
      if (amount !== 0) pairs.push([chars[a].codePointAt(0), chars[b].codePointAt(0), amount]);
    }
  }
  return pairs;
}

function assertNoKanjiKerning(ctx, chars, advances, kanjiIndices) {
  let seed = 20261126;
  const next = (limit) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % limit;
  };
  for (let i = 0; i < KANJI_KERN_SAMPLES; i += 1) {
    const kanji = kanjiIndices[next(kanjiIndices.length)];
    const other = next(chars.length);
    for (const [first, second] of [[kanji, other], [other, kanji]]) {
      const kern = ctx.measureText(chars[first] + chars[second]).width - advances[first] - advances[second];
      if (Math.abs(kern) > 1e-9) throw new Error(`Unexpected kerning between ${chars[first]} and ${chars[second]}`);
    }
  }
}

function inkCentroidY(ctx, left, top, width, height) {
  const { data } = ctx.getImageData(left, top, width, height);
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < width * height; i += 1) {
    weighted += data[i * 4 + 3] * (top + (i / width | 0) + 0.5);
    total += data[i * 4 + 3];
  }
  return weighted / total;
}

function measureBaselineShift(px) {
  const mixed = contextForFont(`bold ${px}px '${GILL}', '${NOTO}'`);
  const latin = contextForFont(`bold ${px}px '${GILL}'`);
  const probeX = BASELINE_PROBE_X + mixed.measureText("あ").width;
  const deltas = BASELINE_PROBES.map((probe) => {
    const box = latin.measureText(probe);
    const left = Math.ceil(probeX - box.actualBoundingBoxLeft);
    const top = Math.floor(BASELINE_PROBE_BASELINE - box.actualBoundingBoxAscent) - 3;
    const width = Math.floor(probeX + box.actualBoundingBoxRight) + 1 - left;
    const height = Math.ceil(box.actualBoundingBoxAscent + box.actualBoundingBoxDescent) + 7;
    mixed.clearRect(0, 0, CELL_SIZE, CELL_SIZE);
    latin.clearRect(0, 0, CELL_SIZE, CELL_SIZE);
    mixed.fillText(`あ${probe}`, BASELINE_PROBE_X, BASELINE_PROBE_BASELINE);
    latin.fillText(probe, probeX, BASELINE_PROBE_BASELINE);
    return inkCentroidY(latin, left, top, width, height) - inkCentroidY(mixed, left, top, width, height);
  });
  return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
}

async function renderLogo() {
  const image = await loadImage(LOGO_FILE);
  const scale = Math.min(LABEL_TEXT_WIDTH / image.width, LABEL_LOGO_MAX_HEIGHT / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const left = LABEL_PAD + (LABEL_TEXT_WIDTH - width) / 2;
  const top = LABEL_HEIGHT - LABEL_PAD - height;
  const x = Math.floor(left);
  const y = Math.floor(top);
  const canvas = createCanvas(Math.ceil(left + width) - x, Math.ceil(top + height) - y);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, left - x, top - y, width, height);
  const rgba = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  return { x, y, width: canvas.width, height: canvas.height, rgba };
}

function logoParity(logo) {
  const reference = createCanvas(LABEL_WIDTH, LABEL_HEIGHT).getContext("2d");
  const recomposed = createCanvas(LABEL_WIDTH, LABEL_HEIGHT).getContext("2d");
  for (const ctx of [reference, recomposed]) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  }
  const patch = createCanvas(logo.width, logo.height);
  const patchCtx = patch.getContext("2d");
  const imageData = patchCtx.createImageData(logo.width, logo.height);
  new Uint8Array(imageData.data.buffer).set(logo.rgba);
  patchCtx.putImageData(imageData, 0, 0);
  recomposed.drawImage(patch, logo.x, logo.y);
  return loadImage(LOGO_FILE).then((image) => {
    const scale = Math.min(LABEL_TEXT_WIDTH / image.width, LABEL_LOGO_MAX_HEIGHT / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    reference.drawImage(image, LABEL_PAD + (LABEL_TEXT_WIDTH - drawWidth) / 2, LABEL_HEIGHT - LABEL_PAD - drawHeight, drawWidth, drawHeight);
    const a = reference.getImageData(0, 0, LABEL_WIDTH, LABEL_HEIGHT).data;
    const b = recomposed.getImageData(0, 0, LABEL_WIDTH, LABEL_HEIGHT).data;
    let maxDifference = 0;
    for (let i = 0; i < a.length; i += 1) maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i]));
    return maxDifference;
  });
}

function writeAtlas(groups, logo) {
  const { header, groupHeader, kern, glyph, variant } = ATLAS_LAYOUT;
  const pixelBytesOf = (group) => group.glyphs.reduce((sum, entry) => sum + entry.blobs.reduce((total, blob) => total + blob.length, 0), 0);
  const variantsOf = (group) => group.sets * group.phases;
  const tableBytes = groups.reduce(
    (sum, group) => sum + groupHeader + group.kerning.length * kern + group.glyphs.length * (glyph + variantsOf(group) * variant),
    0,
  );
  const pixelBytes = groups.reduce((sum, group) => sum + pixelBytesOf(group), 0);
  const pixelStart = header + tableBytes;
  const out = new Uint8Array(pixelStart + pixelBytes + logo.rgba.length);
  const view = new DataView(out.buffer);
  out.set(new Uint8Array(new Uint32Array([ATLAS_MAGIC]).buffer), 0);
  view.setUint16(4, ATLAS_VERSION, true);
  view.setUint16(6, LABEL_WIDTH, true);
  view.setUint16(8, LABEL_HEIGHT, true);
  view.setUint8(10, groups.length);
  view.setUint16(12, logo.width, true);
  view.setUint16(14, logo.height, true);
  view.setInt16(16, logo.x, true);
  view.setInt16(18, logo.y, true);
  view.setUint32(20, logo.rgba.length, true);
  view.setUint32(24, pixelBytes, true);
  let offset = header;
  for (const group of groups) {
    view.setUint8(offset, FONT_IDS.get(group.font));
    view.setUint8(offset + 1, group.phases);
    view.setUint8(offset + 2, group.sets);
    view.setUint16(offset + 4, group.px, true);
    view.setUint16(offset + 6, group.glyphs.length, true);
    view.setUint16(offset + 8, group.kerning.length, true);
    view.setInt16(offset + 10, group.shift, true);
    offset += groupHeader;
  }
  let pixelOffset = pixelStart;
  for (const group of groups) {
    const groupPixelStart = pixelOffset;
    let glyphPixelOffset = 0;
    for (const [first, second, amount] of group.kerning) {
      view.setUint16(offset, first, true);
      view.setUint16(offset + 2, second, true);
      view.setInt16(offset + 4, amount, true);
      offset += kern;
    }
    for (const entry of group.glyphs) {
      view.setUint32(offset, entry.codePoint, true);
      view.setUint16(offset + 4, entry.advance, true);
      view.setUint8(offset + 6, entry.script);
      view.setUint32(offset + 8, glyphPixelOffset, true);
      offset += glyph;
      for (const shape of entry.variants) {
        view.setInt16(offset, shape.ox, true);
        view.setInt16(offset + 2, shape.oy, true);
        view.setUint16(offset + 4, shape.w, true);
        view.setUint16(offset + 6, shape.h, true);
        offset += variant;
      }
      glyphPixelOffset += entry.blobs.reduce((total, blob) => total + blob.length, 0);
    }
    for (const entry of group.glyphs) {
      for (const blob of entry.blobs) {
        out.set(blob, pixelOffset);
        pixelOffset += blob.length;
      }
    }
  }
  out.set(logo.rgba, pixelOffset);
  return { bytes: out, pixelBytes };
}

async function main() {
  registerFont(GILL_FILE, { family: GILL });
  registerFont(NOTO_FILE, { family: NOTO_ALIAS });
  const gillCodePoints = [...parseCmap(GILL_FILE)].sort((a, b) => a - b);
  const notoCmap = parseCmap(NOTO_FILE);
  const decoder = new TextDecoder("euc-jp");
  const kanjiCodePoints = new Set(jisCodePoints(decoder, JIS_LEVEL_ONE_KANJI_ROWS));
  const jisCodePointsAll = [...jisCodePoints(decoder, JIS_NON_KANJI_ROWS), ...kanjiCodePoints, ...EXTRA_NOTO_CODE_POINTS, FALLBACK_CODE_POINT];
  const notoCodePoints = [...new Set(jisCodePointsAll)].filter((cp) => notoCmap.has(cp)).sort((a, b) => a - b);
  const toChars = (codePoints) => codePoints.map((cp) => String.fromCodePoint(cp));
  const charSets = { gill: toChars(gillCodePoints), noto: toChars(notoCodePoints) };
  const isKanji = (char) => kanjiCodePoints.has(char.codePointAt(0));
  const kanjiIndices = charSets.noto.flatMap((char, index) => (isKanji(char) ? [index] : []));
  const latinAdvance = contextForFont(`bold 20px '${NOTO}'`).measureText("A").width;
  if (latinAdvance < NOTO_BOLD_MIN_LATIN_ADVANCE) {
    throw new Error(`Noto Sans JP gives 'A' an advance of ${latinAdvance}px at 20px; the bold axis is not selected`);
  }
  const baselineShifts = new Map([[18, measureBaselineShift(18)], [20, measureBaselineShift(20)]]);
  for (const [px, shift] of baselineShifts) {
    if (shift < BASELINE_SHIFT_RANGE[0] * px / 20 || shift > BASELINE_SHIFT_RANGE[1] * px / 20) {
      throw new Error(`Pango moves Latin text ${shift.toFixed(3)}px in a line that starts with Japanese at ${px}px`);
    }
  }
  const shiftReport = [...baselineShifts].map(([px, shift]) => `${shift.toFixed(3)}px at ${px}px`).join(", ");
  console.log(`baseline shift of Latin text after Japanese: ${shiftReport}`);
  const groups = [];
  for (const spec of GROUP_SPECS) {
    const chars = charSets[spec.set];
    const ctx = contextForFont(`bold ${spec.px}px '${spec.font}'`);
    const advances = chars.map((char) => ctx.measureText(char).width);
    const kernChars = spec.set === "noto" ? chars.filter((char) => !isKanji(char)) : chars;
    const kerning = measureKerning(ctx, kernChars, kernChars.map((char) => ctx.measureText(char).width));
    if (spec.set === "noto") assertNoKanjiKerning(ctx, chars, advances, kanjiIndices);
    const raise = spec.sets === 1 ? 0 : baselineShifts.get(spec.px);
    const shift = spec.raises ? -raise : raise;
    const entries = chars.map((char) => rasterizeGlyph(ctx, char.codePointAt(0), spec.phases, spec.sets, shift));
    if (spec.fallback) {
      entries.push(rasterizeGlyph(contextForFont(`bold ${spec.px}px '${NOTO}'`), FALLBACK_CODE_POINT, spec.phases, 1, 0));
    }
    entries.sort((a, b) => a.codePoint - b.codePoint);
    const index = new Map(entries.map((entry, i) => [entry.codePoint, i]));
    groups.push({
      font: spec.font,
      px: spec.px,
      phases: spec.phases,
      sets: spec.sets,
      shift: Math.round((spec.raises ? raise : -raise) * ADVANCE_UNIT),
      glyphs: entries,
      kerning: kerning.map(([first, second, amount]) => [index.get(first), index.get(second), amount]),
    });
    console.log(`${spec.font} ${spec.px}px: ${entries.length} glyphs x ${spec.sets} set(s) x ${spec.phases} phase(s), ${kerning.length} kerning pairs`);
  }
  const logo = await renderLogo();
  const { bytes, pixelBytes } = writeAtlas(groups, logo);
  const atlas = parseAtlas(bytes);
  for (const style of Object.values(atlas.styles)) {
    const lastGroup = style.groups[style.groups.length - 1];
    if (!lastGroup.glyphs.get(FALLBACK_CODE_POINT)) throw new Error(`Glyph group ${lastGroup.index} has no placeholder square`);
  }
  writeFileSync(OUTPUT_FILE, bytes);
  console.log(`atlas.bin: ${bytes.length} bytes (${(bytes.length / 1048576).toFixed(2)} MiB), glyph pixels ${pixelBytes}, logo ${logo.width}x${logo.height} at ${logo.x},${logo.y}`);
  console.log(`logo re-composited, max channel difference: ${await logoParity(logo)}`);
  if (process.platform !== "linux") console.log("NOTE: built outside the production image, so anti-aliasing and baseline shift follow this machine's fonts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
