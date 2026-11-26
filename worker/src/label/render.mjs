import { create as createQr } from "qrcode/lib/core/qrcode.js";
import { drawText, measureText, wrapText } from "./text.mjs";
import { encodePng } from "./png.mjs";

export const LABEL_WIDTH = 548;
export const LABEL_HEIGHT = 338;
export const LABEL_PAD = 7;
export const LABEL_LOGO_MAX_HEIGHT = 140;
const QR_SIZE = 326;
const QR_SOURCE_SIZE = 400;
const QR_QUIET_MODULES = 1;
const QR_GAP = 5;
const QR_X = LABEL_WIDTH - LABEL_PAD - QR_SIZE;
const QR_Y = LABEL_PAD;
const LEFT_X = LABEL_PAD;
export const LABEL_TEXT_WIDTH = QR_X - QR_GAP - LEFT_X;
const MVD_BASELINE = LABEL_PAD + 40;
const SERIAL_BASELINE = MVD_BASELINE + 28;
const NAME_BASELINE = SERIAL_BASELINE + 24;
const NAME_LINE_HEIGHT = 24;
const NAME_MAX_LINES = 20;
const MAX_QR_MODULES = 177;
const WHITE = 255;

const QR_TAPS = buildQrTaps();
const QR_MODULE_OF_SOURCE = new Int16Array(QR_SOURCE_SIZE);
const QR_ROW_DARKNESS = new Float64Array(MAX_QR_MODULES);

function buildQrTaps() {
  const first = new Int16Array(QR_SIZE);
  const second = new Int16Array(QR_SIZE);
  const weight = new Float64Array(QR_SIZE);
  const scale = QR_SOURCE_SIZE / QR_SIZE;
  for (let i = 0; i < QR_SIZE; i += 1) {
    const centre = (i + 0.5) * scale - 0.5;
    const start = Math.min(QR_SOURCE_SIZE - 1, Math.max(0, Math.floor(centre)));
    first[i] = start;
    second[i] = Math.min(QR_SOURCE_SIZE - 1, start + 1);
    weight[i] = centre - start;
  }
  return { first, second, weight };
}

function mapSourcePixelsToModules(moduleSize) {
  const quiet = QR_QUIET_MODULES * moduleSize;
  for (let source = 0; source < QR_SOURCE_SIZE; source += 1) {
    const inside = source >= quiet && source < QR_SOURCE_SIZE - quiet;
    QR_MODULE_OF_SOURCE[source] = inside ? Math.floor((source - quiet) / moduleSize) : -1;
  }
}

function drawQr(canvas, modules) {
  const size = modules.size;
  const data = modules.data;
  mapSourcePixelsToModules(QR_SOURCE_SIZE / (size + 2 * QR_QUIET_MODULES));
  const { first, second, weight } = QR_TAPS;
  const out = canvas.data;
  const stride = canvas.width * 3;
  for (let y = 0; y < QR_SIZE; y += 1) {
    const rowA = QR_MODULE_OF_SOURCE[first[y]];
    const rowB = QR_MODULE_OF_SOURCE[second[y]];
    const mix = weight[y];
    for (let module = 0; module < size; module += 1) {
      const darkA = rowA < 0 ? 0 : data[rowA * size + module];
      const darkB = rowB < 0 ? 0 : data[rowB * size + module];
      QR_ROW_DARKNESS[module] = darkA + (darkB - darkA) * mix;
    }
    let target = (QR_Y + y) * stride + QR_X * 3;
    for (let x = 0; x < QR_SIZE; x += 1, target += 3) {
      const columnA = QR_MODULE_OF_SOURCE[first[x]];
      const columnB = QR_MODULE_OF_SOURCE[second[x]];
      const darkA = columnA < 0 ? 0 : QR_ROW_DARKNESS[columnA];
      let dark = darkA;
      if (columnA !== columnB) {
        const darkB = columnB < 0 ? 0 : QR_ROW_DARKNESS[columnB];
        dark = darkA + (darkB - darkA) * weight[x];
      }
      const value = Math.round(WHITE * (1 - dark));
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
    }
  }
}

function truncateSerial(style, serial) {
  let text = serial;
  while (measureText(style, text) > LABEL_TEXT_WIDTH && text.length > 4) text = `${text.slice(0, -2)}…`;
  return text;
}

function drawLogo(canvas, logo) {
  const { rgba, width, height, x, y } = logo;
  const data = canvas.data;
  const stride = canvas.width * 3;
  for (let row = 0; row < height; row += 1) {
    const targetRow = y + row;
    if (targetRow < 0 || targetRow >= canvas.height) continue;
    for (let col = 0; col < width; col += 1) {
      const targetColumn = x + col;
      if (targetColumn < 0 || targetColumn >= canvas.width) continue;
      const source = (row * width + col) * 4;
      const alpha = rgba[source + 3];
      if (alpha === 0) continue;
      const target = targetRow * stride + targetColumn * 3;
      const keep = WHITE - alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        data[target + channel] = alpha === WHITE
          ? rgba[source + channel]
          : ((rgba[source + channel] * alpha + data[target + channel] * keep + 127) / WHITE) | 0;
      }
    }
  }
}

/** Compose the shipping label of an item with its QR code and return a PNG. */
export async function composeLabel(atlas, item, qrText) {
  const canvas = {
    data: new Uint8Array(LABEL_WIDTH * LABEL_HEIGHT * 3).fill(WHITE),
    width: LABEL_WIDTH,
    height: LABEL_HEIGHT,
  };
  drawQr(canvas, createQr(qrText, { errorCorrectionLevel: "L" }).modules);
  drawText(canvas, atlas.styles.mvd, String(item.mvd || "-").trim(), LEFT_X, MVD_BASELINE);
  const serial = (item.serial_clean || item.serial_raw || "-").trim();
  drawText(canvas, atlas.styles.serial, truncateSerial(atlas.styles.serial, serial), LEFT_X, SERIAL_BASELINE);
  const name = (item.name || "-").trim();
  wrapText(canvas, atlas.styles.name, name, LEFT_X, NAME_BASELINE, LABEL_TEXT_WIDTH, NAME_LINE_HEIGHT, NAME_MAX_LINES);
  drawLogo(canvas, atlas.logo);
  return encodePng(canvas.data, canvas.width, canvas.height);
}
