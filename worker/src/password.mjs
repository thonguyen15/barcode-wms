const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HASH_PARTS = 4;

export const DEFAULT_ITERATIONS = 25_000;

/** Hash a password as pbkdf2$<iterations>$<salt_b64>$<hash_b64>. */
export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, iterations);
  return `pbkdf2$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/** Check a password against a stored hash; a malformed hash never matches. */
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const actual = await deriveBits(String(password ?? ""), parsed.salt, parsed.iterations);
  return bytesEqual(actual, parsed.hash);
}

function parsePasswordHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== HASH_PARTS || parts[0] !== "pbkdf2") return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  try {
    return { iterations, salt: base64ToBytes(parts[2]), hash: base64ToBytes(parts[3]) };
  } catch {
    return null;
  }
}

async function deriveBits(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function bytesEqual(a, b) {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
