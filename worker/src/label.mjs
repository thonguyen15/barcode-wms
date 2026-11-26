const PLACEHOLDER_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 250, 207, 192, 240, 31, 0, 5, 5,
  2, 0, 91, 171, 38, 126, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/** Render the shipping label PNG; placeholder until the label renderer slice lands. */
export async function renderLabel(item, qrBuffer) {
  console.warn("[LABEL] renderLabel stub used — real label renderer not integrated yet");
  return PLACEHOLDER_PNG;
}

/** Produce the QR PNG buffer for a token; placeholder until the label renderer slice lands. */
export async function renderQrBuffer(token) {
  console.warn("[LABEL] renderQrBuffer stub used — real QR renderer not integrated yet");
  return new Uint8Array(0);
}
