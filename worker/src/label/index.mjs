import atlasData from "./atlas.bin";
import { parseAtlas } from "./atlas.mjs";
import { composeLabel } from "./render.mjs";

const atlas = parseAtlas(atlasData);

/** Render the shipping label PNG of an item for the text encoded in its QR code. */
export async function renderLabel(item, qrText) {
  return composeLabel(atlas, item, qrText);
}
