import { FALLBACK_CODE_POINT, SCRIPT_COMMON, SCRIPT_IDEOGRAPHIC } from "./atlas.mjs";

const IGNORED = /[\p{M}\p{Cf}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const SPACE_LIKE = /[\t\p{Zs}\p{Zl}\p{Zp}]/u;
const OGHAM_SPACE_MARK = 0x1680;
const SPACE = 0x20;
const KERN_KEY_SHIFT = 65536;

let missingGlyphWarned = false;

function warnMissingGlyph(codePoint) {
  if (missingGlyphWarned) return;
  missingGlyphWarned = true;
  console.warn(`[label] No glyph for U+${codePoint.toString(16).toUpperCase()}; drawing a placeholder square`);
}

function isSpaceLike(ch) {
  const codePoint = ch.codePointAt(0);
  return codePoint !== OGHAM_SPACE_MARK && SPACE_LIKE.test(ch);
}

function findGlyph(style, codePoint, inheritedGroup, spaceLike) {
  const groups = style.groups;
  if (spaceLike) {
    const group = inheritedGroup ?? groups[0];
    return { group, glyph: group.glyphs.get(codePoint) ?? group.glyphs.get(SPACE) };
  }
  if (inheritedGroup) {
    const glyph = inheritedGroup.glyphs.get(codePoint);
    if (glyph) return { group: inheritedGroup, glyph };
  }
  for (const group of groups) {
    const glyph = group.glyphs.get(codePoint);
    if (glyph) return { group, glyph };
  }
  const last = groups[groups.length - 1];
  warnMissingGlyph(codePoint);
  return { group: last, glyph: last.glyphs.get(FALLBACK_CODE_POINT), missing: true };
}

function newLine(style, x) {
  return {
    style,
    startX: x,
    x,
    paint: true,
    placed: [],
    run: null,
    group: null,
    firstGroup: null,
    firstScript: null,
    sawGlyph: false,
    previous: null,
    rawLength: 0,
    pending: [],
    resume: null,
  };
}

function pushStep(line, ch, forcedGroup) {
  const spaceLike = isSpaceLike(ch);
  const step = findGlyph(line.style, ch.codePointAt(0), spaceLike ? forcedGroup ?? line.group : null, spaceLike);
  const { glyph } = step;
  const previous = line.previous;
  const sameRun = line.run === null || glyph.script === SCRIPT_COMMON || glyph.script === line.run;
  step.kern = previous && !previous.missing && sameRun && previous.group === step.group
    ? (step.group.kern.get(previous.glyph.index * KERN_KEY_SHIFT + glyph.index) ?? 0)
    : 0;
  const x = line.x + step.kern;
  if (line.paint) line.placed.push({ group: step.group, glyph, x });
  line.x = x + glyph.advance;
  line.group = step.missing ? null : step.group;
  if (!step.missing && glyph.script !== SCRIPT_COMMON) {
    if (line.firstScript === null) line.firstScript = glyph.script;
    line.run = glyph.script;
  }
  if (!spaceLike) {
    if (line.firstGroup === null) line.firstGroup = step.missing ? line.style.groups[0] : step.group;
    line.sawGlyph = true;
  }
  line.previous = step;
}

function append(line, ch) {
  line.rawLength += ch.length;
  if (IGNORED.test(ch)) return;
  if (isSpaceLike(ch)) {
    if (line.pending.length === 0) {
      line.resume = { x: line.x, previous: line.previous, placed: line.placed.length, group: line.group };
    }
    line.pending.push(ch);
    pushStep(line, ch, null);
    return;
  }
  const next = findGlyph(line.style, ch.codePointAt(0), null, false);
  const sameRun = next.glyph.script === SCRIPT_COMMON || line.run === null || next.glyph.script === line.run;
  const betterFont = next.group.index < (line.group ?? line.style.groups[0]).index;
  if (line.pending.length > 0 && sameRun && (!line.sawGlyph || betterFont)) {
    const { resume } = line;
    line.x = resume.x;
    line.previous = resume.previous;
    line.group = resume.group;
    if (line.paint) line.placed.length = resume.placed;
    for (const space of line.pending) pushStep(line, space, next.group);
  }
  line.pending = [];
  pushStep(line, ch, null);
}

function widthAfter(line, ch) {
  const scratch = { ...line, paint: false, placed: [], pending: [...line.pending] };
  append(scratch, ch);
  return scratch.x - scratch.startX;
}

function paint(canvas, line, baseline) {
  const ideographic = line.firstScript !== null && SCRIPT_IDEOGRAPHIC.has(line.firstScript);
  for (const placed of line.placed) {
    const shifted = ideographic && placed.group !== line.firstGroup && placed.group.rasterSets > 1;
    blitGlyph(canvas, placed.group, placed.glyph, placed.x, baseline, shifted ? 1 : 0);
  }
}

function blitGlyph(canvas, group, glyph, x, baseline, set) {
  const phases = group.phases;
  let left = Math.floor(x);
  let phase = Math.round((x - left) * phases);
  if (phase === phases) {
    phase = 0;
    left += 1;
  }
  const variant = glyph.variants[set * phases + phase];
  const width = variant.w;
  const height = variant.h;
  if (width === 0 || height === 0) return;
  left += variant.ox;
  const top = baseline + variant.oy;
  const data = canvas.data;
  const canvasWidth = canvas.width;
  const stride = canvasWidth * 3;
  const pixels = group.pixels;
  for (let row = 0; row < height; row += 1) {
    const y = top + row;
    if (y < 0 || y >= canvas.height) continue;
    const rowStart = y * stride;
    let source = variant.off + row * width;
    for (let col = 0; col < width; col += 1, source += 1) {
      const px = left + col;
      if (px < 0 || px >= canvasWidth) continue;
      const alpha = pixels[source];
      if (alpha === 0) continue;
      const target = rowStart + px * 3;
      if (alpha === 255) {
        data[target] = 0;
        data[target + 1] = 0;
        data[target + 2] = 0;
        continue;
      }
      const keep = 255 - alpha;
      data[target] = ((data[target] * keep + 127) / 255) | 0;
      data[target + 1] = ((data[target + 1] * keep + 127) / 255) | 0;
      data[target + 2] = ((data[target + 2] * keep + 127) / 255) | 0;
    }
  }
}

/** Measure the width a string takes in a text style, in pixels. */
export function measureText(style, text) {
  const line = newLine(style, 0);
  line.paint = false;
  for (const ch of text) append(line, ch);
  return line.x - line.startX;
}

/** Draw one line of text with its baseline at `baseline`, clipped to the label. */
export function drawText(canvas, style, text, x, baseline) {
  const line = newLine(style, x);
  for (const ch of text) append(line, ch);
  paint(canvas, line, baseline);
}

/** Wrap text like the Express label: break on width or newline, at most `maxLines` breaks. */
export function wrapText(canvas, style, text, x, baseline, maxWidth, lineHeight, maxLines) {
  if (!text) return baseline;
  let y = baseline;
  let breaks = 0;
  let line = newLine(style, x);
  for (const ch of text) {
    if (ch === "\n") {
      paint(canvas, line, y);
      y += lineHeight;
      breaks += 1;
      line = newLine(style, x);
      if (maxLines && breaks >= maxLines) return y;
      continue;
    }
    if (widthAfter(line, ch) > maxWidth && line.rawLength > 0) {
      paint(canvas, line, y);
      y += lineHeight;
      breaks += 1;
      if (maxLines && breaks >= maxLines) return y;
      line = newLine(style, x);
    }
    append(line, ch);
  }
  if (line.rawLength > 0) {
    paint(canvas, line, y);
    y += lineHeight;
  }
  return y;
}
