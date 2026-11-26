const MAGIC = 0x4c41424c;
const VERSION = 2;
const HEADER_BYTES = 28;
const GROUP_HEADER_BYTES = 12;
const KERN_RECORD_BYTES = 6;
const GLYPH_RECORD_BYTES = 12;
const VARIANT_RECORD_BYTES = 8;
const GROUP_COUNT = 5;

export const ATLAS_MAGIC = MAGIC;
export const ATLAS_VERSION = VERSION;
export const ATLAS_GROUP_COUNT = GROUP_COUNT;
export const ATLAS_LAYOUT = Object.freeze({
  header: HEADER_BYTES,
  groupHeader: GROUP_HEADER_BYTES,
  kern: KERN_RECORD_BYTES,
  glyph: GLYPH_RECORD_BYTES,
  variant: VARIANT_RECORD_BYTES,
});
export const ADVANCE_UNIT = 256;
export const FALLBACK_CODE_POINT = 0x25a1;
export const SCRIPT_COMMON = 0;
export const SCRIPT_LATIN = 1;
export const SCRIPT_GREEK = 2;
export const SCRIPT_CYRILLIC = 3;
export const SCRIPT_HIRAGANA = 4;
export const SCRIPT_KATAKANA = 5;
export const SCRIPT_HAN = 6;
export const SCRIPT_IDEOGRAPHIC = new Set([SCRIPT_HIRAGANA, SCRIPT_KATAKANA, SCRIPT_HAN]);
export const GROUP_MVD = 0;
export const GROUP_SERIAL_LATIN = 1;
export const GROUP_NAME_LATIN = 2;
export const GROUP_SERIAL_CJK = 3;
export const GROUP_NAME_CJK = 4;

function readGroupHeader(view, offset) {
  return {
    font: view.getUint8(offset),
    phases: view.getUint8(offset + 1),
    rasterSets: view.getUint8(offset + 2),
    px: view.getUint16(offset + 4, true),
    glyphCount: view.getUint16(offset + 6, true),
    kernCount: view.getUint16(offset + 8, true),
    shift: view.getInt16(offset + 10, true) / ADVANCE_UNIT,
  };
}

function readKernTable(view, offset, count) {
  const kern = new Map();
  for (let i = 0; i < count; i += 1) {
    const first = view.getUint16(offset, true);
    const second = view.getUint16(offset + 2, true);
    kern.set(first * 65536 + second, view.getInt16(offset + 4, true) / ADVANCE_UNIT);
    offset += KERN_RECORD_BYTES;
  }
  return { kern, offset };
}

function readGlyphTable(view, offset, phases, rasterSets, count) {
  const glyphs = new Map();
  let pixelBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const codePoint = view.getUint32(offset, true);
    const advance = view.getUint16(offset + 4, true) / ADVANCE_UNIT;
    const script = view.getUint8(offset + 6);
    let variantOffset = view.getUint32(offset + 8, true);
    offset += GLYPH_RECORD_BYTES;
    const variants = new Array(phases * rasterSets);
    for (let variant = 0; variant < variants.length; variant += 1) {
      const width = view.getUint16(offset + 4, true);
      const height = view.getUint16(offset + 6, true);
      variants[variant] = {
        ox: view.getInt16(offset, true),
        oy: view.getInt16(offset + 2, true),
        w: width,
        h: height,
        off: variantOffset,
      };
      variantOffset += width * height;
      offset += VARIANT_RECORD_BYTES;
    }
    pixelBytes = Math.max(pixelBytes, variantOffset);
    glyphs.set(codePoint, { index, advance, script, variants });
  }
  return { glyphs, offset, pixelBytes };
}

/** Parse the label atlas binary into glyph, kerning and logo tables. */
export function parseAtlas(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(4, true);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a label atlas");
  if (version !== VERSION) throw new Error(`Unsupported label atlas version ${version}`);
  if (view.getUint8(10) !== GROUP_COUNT) throw new Error(`Expected ${GROUP_COUNT} glyph groups`);
  const logoBytes = view.getUint32(20, true);
  const pixelBytes = view.getUint32(24, true);
  let offset = HEADER_BYTES;
  const headers = [];
  for (let i = 0; i < GROUP_COUNT; i += 1) {
    headers.push(readGroupHeader(view, offset));
    offset += GROUP_HEADER_BYTES;
  }
  const tables = [];
  for (const header of headers) {
    const kernTable = readKernTable(view, offset, header.kernCount);
    const glyphTable = readGlyphTable(view, kernTable.offset, header.phases, header.rasterSets, header.glyphCount);
    tables.push({ header, glyphs: glyphTable.glyphs, kern: kernTable.kern, pixelBytes: glyphTable.pixelBytes });
    offset = glyphTable.offset;
  }
  if (offset + pixelBytes + logoBytes !== data.byteLength) throw new Error("Corrupt label atlas");
  const groups = [];
  let cursor = 0;
  for (const table of tables) {
    groups.push({
      index: groups.length,
      font: table.header.font,
      px: table.header.px,
      phases: table.header.phases,
      rasterSets: table.header.rasterSets,
      shift: table.header.shift,
      glyphs: table.glyphs,
      kern: table.kern,
      pixels: data.subarray(offset + cursor, offset + cursor + table.pixelBytes),
    });
    cursor += table.pixelBytes;
  }
  return {
    labelWidth: view.getUint16(6, true),
    labelHeight: view.getUint16(8, true),
    logo: {
      width: view.getUint16(12, true),
      height: view.getUint16(14, true),
      x: view.getInt16(16, true),
      y: view.getInt16(18, true),
      rgba: data.subarray(offset + cursor, offset + cursor + logoBytes),
    },
    groups,
    styles: {
      mvd: { groups: [groups[GROUP_MVD]] },
      serial: { groups: [groups[GROUP_SERIAL_LATIN], groups[GROUP_SERIAL_CJK]] },
      name: { groups: [groups[GROUP_NAME_LATIN], groups[GROUP_NAME_CJK]] },
    },
  };
}
