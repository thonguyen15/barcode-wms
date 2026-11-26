import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAtlas } from "../src/label/atlas.mjs";
import {
  LABEL_HEIGHT,
  LABEL_LOGO_MAX_HEIGHT,
  LABEL_PAD,
  LABEL_WIDTH,
  composeLabel,
} from "../src/label/render.mjs";
import { SAMPLE_ITEMS } from "../src/label/samples.mjs";

const require = createRequire(import.meta.url);
const { createCanvas, loadImage, registerFont } = require("canvas");
const QRCode = require("qrcode");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ATLAS_FILE = path.join(ROOT, "worker/src/label/atlas.bin");
const DEFAULT_OUT_DIR = path.join(ROOT, "worker/dist/label-compare");
const QR_SIZE = 326;
const QR_X = LABEL_WIDTH - LABEL_PAD - QR_SIZE;
const QR_Y = LABEL_PAD;
const PANEL_GAP = 16;
const CAPTION_HEIGHT = 36;
const LUMA = [0.2126, 0.7152, 0.0722];
const REFERENCES = [
  { name: "production", caption: "server.js canvas, production fonts", font: "bold 20px 'Gill Sans MT', 'Hiragino Sans'" },
  { name: "same-fonts", caption: "server.js canvas, atlas fonts", font: "bold 20px 'Gill Sans MT', 'Noto Sans JP'" },
];

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT_DIR, samples: [], threshold: 32, maxDiff: null };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === "--out" && value) options.out = path.resolve(value);
    else if (argv[i] === "--sample" && value) options.samples.push(value);
    else if (argv[i] === "--threshold" && value) options.threshold = Number(value);
    else if (argv[i] === "--max-diff" && value) options.maxDiff = Number(value);
    else throw new Error(`Unknown or incomplete argument ${argv[i]}`);
  }
  if (options.samples.length === 0) options.samples.push(...Object.keys(SAMPLE_ITEMS));
  for (const key of options.samples) if (!SAMPLE_ITEMS[key]) throw new Error(`Unknown sample "${key}"`);
  return options;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  if (!text) return y;
  let lines = 0;
  let currentLine = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      ctx.fillText(currentLine, x, y);
      y += lineHeight;
      lines += 1;
      currentLine = "";
      if (maxLines && lines >= maxLines) return y;
      continue;
    }
    const testLine = currentLine + char;
    if (ctx.measureText(testLine).width > maxWidth && currentLine.length > 0) {
      ctx.fillText(currentLine, x, y);
      y += lineHeight;
      lines += 1;
      if (maxLines && lines >= maxLines) return y;
      currentLine = char;
    } else currentLine = testLine;
  }
  if (currentLine) {
    ctx.fillText(currentLine, x, y);
    y += lineHeight;
  }
  return y;
}

async function renderReference(item, qrBuffer, nameFont, logo) {
  const canvas = createCanvas(LABEL_WIDTH, LABEL_HEIGHT);
  const ctx = canvas.getContext("2d");
  const pad = LABEL_PAD;
  const qrX = LABEL_WIDTH - pad - QR_SIZE;
  const leftX = pad;
  const textWidth = qrX - 5 - leftX;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  ctx.drawImage(await loadImage(qrBuffer), qrX, pad, QR_SIZE, QR_SIZE);
  ctx.fillStyle = "#000";
  ctx.font = "bold 34px 'Gill Sans MT'";
  let y = pad + 40;
  ctx.fillText(String(item.mvd || "-").trim(), leftX, y);
  y += 28;
  ctx.font = "bold 18px 'Gill Sans MT'";
  let serial = (item.serial_clean || item.serial_raw || "-").trim();
  while (ctx.measureText(serial).width > textWidth && serial.length > 4) serial = `${serial.slice(0, -2)}…`;
  ctx.fillText(serial, leftX, y);
  y += 24;
  ctx.font = nameFont;
  wrapText(ctx, (item.name || "-").trim(), leftX, y, textWidth, 24, 20);
  const scale = Math.min(textWidth / logo.width, LABEL_LOGO_MAX_HEIGHT / logo.height);
  const drawWidth = logo.width * scale;
  const drawHeight = logo.height * scale;
  ctx.drawImage(logo, leftX + (textWidth - drawWidth) / 2, LABEL_HEIGHT - pad - drawHeight, drawWidth, drawHeight);
  return { canvas, png: canvas.toBuffer("image/png") };
}

function luminance(canvas) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
  const gray = new Uint8ClampedArray(data.length / 4);
  for (let i = 0; i < gray.length; i += 1) gray[i] = LUMA[0] * data[i * 4] + LUMA[1] * data[i * 4 + 1] + LUMA[2] * data[i * 4 + 2];
  return gray;
}

function difference(reference, atlas, threshold) {
  const stats = { pixels: 0, textPixels: 0, qrPixels: 0, max: 0, sum: 0, perPixel: new Uint8Array(reference.length) };
  for (let y = 0; y < LABEL_HEIGHT; y += 1) {
    const insideQrRow = y >= QR_Y && y < QR_Y + QR_SIZE;
    for (let x = 0; x < LABEL_WIDTH; x += 1) {
      const i = y * LABEL_WIDTH + x;
      const delta = Math.abs(reference[i] - atlas[i]);
      stats.perPixel[i] = delta;
      stats.sum += delta;
      if (delta > stats.max) stats.max = delta;
      if (delta <= threshold) continue;
      stats.pixels += 1;
      if (insideQrRow && x >= QR_X && x < QR_X + QR_SIZE) stats.qrPixels += 1;
      else stats.textPixels += 1;
    }
  }
  const { perPixel, ...metrics } = stats;
  const total = LABEL_WIDTH * LABEL_HEIGHT;
  const qrArea = QR_SIZE * QR_SIZE;
  return {
    ...metrics,
    fraction: metrics.pixels / total,
    textFraction: metrics.textPixels / (total - qrArea),
    qrFraction: metrics.qrPixels / qrArea,
    mean: metrics.sum / total,
    perPixel,
  };
}

function saveComparison(file, reference, atlasImage, referenceCaption, diff, threshold) {
  const width = LABEL_WIDTH * 3 + PANEL_GAP * 2;
  const canvas = createCanvas(width, LABEL_HEIGHT + CAPTION_HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, canvas.height);
  const heat = ctx.createImageData(LABEL_WIDTH, LABEL_HEIGHT);
  for (let i = 0; i < diff.perPixel.length; i += 1) {
    heat.data[i * 4] = 255;
    heat.data[i * 4 + 1] = 255 - diff.perPixel[i];
    heat.data[i * 4 + 2] = 255 - diff.perPixel[i];
    heat.data[i * 4 + 3] = 255;
  }
  const panels = [
    { caption: referenceCaption, draw: (x) => ctx.drawImage(reference.canvas, x, CAPTION_HEIGHT) },
    { caption: "atlas renderer (Worker)", draw: (x) => ctx.drawImage(atlasImage, x, CAPTION_HEIGHT) },
    { caption: `|difference|, red = above ${threshold}`, draw: (x) => ctx.putImageData(heat, x, CAPTION_HEIGHT) },
  ];
  ctx.fillStyle = "#000";
  ctx.font = "20px sans-serif";
  panels.forEach((panel, index) => {
    const x = index * (LABEL_WIDTH + PANEL_GAP);
    ctx.fillText(panel.caption, x, 25);
    panel.draw(x);
  });
  writeFileSync(file, canvas.toBuffer("image/png"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  registerFont(path.join(ROOT, "fonts/NotoSansJP-Bold.ttf"), { family: "Noto Sans JP" });
  registerFont(path.join(ROOT, "fonts/GillSansMT_Bold.ttf"), { family: "Gill Sans MT" });
  registerFont(path.join(ROOT, "fonts/Hiragino_Sans_GB_W3.ttf"), { family: "Hiragino Sans" });
  const atlas = parseAtlas(readFileSync(ATLAS_FILE));
  const logo = await loadImage(path.join(ROOT, "public/images/logo.png"));
  mkdirSync(options.out, { recursive: true });
  const rows = [];
  const reports = [];
  for (const key of options.samples) {
    const item = SAMPLE_ITEMS[key];
    const qrBuffer = await QRCode.toBuffer(item.qrText, { margin: 1, width: 400, errorCorrectionLevel: "L" });
    const atlasPng = await composeLabel(atlas, item, item.qrText);
    const atlasImage = await loadImage(Buffer.from(atlasPng));
    const atlasCanvas = createCanvas(LABEL_WIDTH, LABEL_HEIGHT);
    atlasCanvas.getContext("2d").drawImage(atlasImage, 0, 0);
    const atlasLuma = luminance(atlasCanvas);
    writeFileSync(path.join(options.out, `${key}-atlas.png`), atlasPng);
    const report = { sample: key, atlasBytes: atlasPng.length, comparisons: {} };
    for (const reference of REFERENCES) {
      const rendered = await renderReference(item, qrBuffer, reference.font, logo);
      const diff = difference(luminance(rendered.canvas), atlasLuma, options.threshold);
      writeFileSync(path.join(options.out, `${key}-${reference.name}.png`), rendered.png);
      saveComparison(path.join(options.out, `${key}-${reference.name}-vs-atlas.png`), rendered, atlasImage, reference.caption, diff, options.threshold);
      rows.push({ sample: key, reference: reference.name, ...diff, perPixel: undefined });
      const { perPixel, ...metrics } = diff;
      report.comparisons[reference.name] = metrics;
    }
    reports.push(report);
  }
  const percent = (value) => `${(value * 100).toFixed(3).padStart(7)}%`;
  console.log(`node-canvas ${require("canvas/package.json").version} on ${process.platform}/${process.arch}, threshold ${options.threshold}`);
  console.log("sample      reference     >thr    of label   text/logo    QR area     max   mean");
  for (const row of rows) {
    console.log(
      `${row.sample.padEnd(11)} ${row.reference.padEnd(12)} ${String(row.pixels).padStart(6)} ${percent(row.fraction)} `
        + `${percent(row.textFraction)} ${percent(row.qrFraction)} ${String(row.max).padStart(6)} ${row.mean.toFixed(2).padStart(6)}`,
    );
  }
  writeFileSync(path.join(options.out, "compare.json"), JSON.stringify(reports, null, 2));
  console.log(`images written to ${path.relative(process.cwd(), options.out)}`);
  if (process.platform !== "linux") {
    console.log("NOTE: outside the production image the canvas fallback fonts come from this machine; only Latin-only samples are trustworthy here");
  }
  if (options.maxDiff !== null) {
    const worst = rows.filter((row) => row.reference === "same-fonts" && !SAMPLE_ITEMS[row.sample].outsideAtlas).reduce((a, b) => (a.textFraction > b.textFraction ? a : b));
    if (worst.textFraction > options.maxDiff) {
      console.error(`same-fonts text difference ${(worst.textFraction * 100).toFixed(3)}% exceeds ${options.maxDiff * 100}% (${worst.sample})`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
