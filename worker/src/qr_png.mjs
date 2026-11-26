import { create as createQr } from "qrcode";

const SCALE = 8;
const QUIET_MODULES = 4;

/** Encode a token as a PNG data URL QR code, matching the old qrcode.toDataURL output shape. */
export async function tokenToQrDataUrl(value) {
  const qr = createQr(value, { errorCorrectionLevel: "L" });
  const count = qr.modules.size + QUIET_MODULES * 2;
  const width = count * SCALE;
  const raw = new Uint8Array((width + 1) * width);
  let offset = 0;
  for (let y = 0; y < width; y += 1) {
    raw[offset] = 0;
    offset += 1;
    const my = Math.floor(y / SCALE) - QUIET_MODULES;
    for (let x = 0; x < width; x += 1) {
      const mx = Math.floor(x / SCALE) - QUIET_MODULES;
      const dark = my >= 0 && my < qr.modules.size && mx >= 0 && mx < qr.modules.size && qr.modules.get(mx, my);
      raw[offset] = dark ? 0 : 255;
      offset += 1;
    }
  }
  const png = encodePng(width, width, raw);
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit grayscale rows (filter byte per row) into a PNG buffer. */
export function encodePng(width, height, raw) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  const stored = new Uint8Array(2 + raw.length + Math.ceil(raw.length / 65535) * 5 + 4);
  let pos = 0;
  stored[pos] = 0x78;
  stored[pos + 1] = 0x01;
  pos += 2;
  let left = raw.length;
  while (left > 0) {
    const block = Math.min(left, 65535);
    const final = left - block === 0 ? 1 : 0;
    stored[pos] = final;
    stored[pos + 1] = block & 0xff;
    stored[pos + 2] = block >>> 8;
    stored[pos + 3] = 255 - (block & 0xff);
    stored[pos + 4] = 255 - (block >>> 8);
    stored.set(raw.subarray(raw.length - left, raw.length - left + block), pos + 5);
    pos += 5 + block;
    left -= block;
  }
  new DataView(stored.buffer).setUint32(pos, adler32(raw));
  pos += 4;
  const idat = stored.subarray(0, pos);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
