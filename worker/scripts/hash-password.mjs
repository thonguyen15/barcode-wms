import { readFileSync } from "node:fs";
import { DEFAULT_ITERATIONS, hashPassword } from "../src/password.mjs";

const args = process.argv.slice(2);
const fromStdin = args.length === 0 || args[0] === "-";

const password = fromStdin ? readFileSync(0, "utf8").replace(/\n$/, "") : args[0];
if (!password) {
  console.error("Usage: node scripts/hash-password.mjs <password> | printf '%s' <password> | node scripts/hash-password.mjs");
  process.exit(1);
}

const iterations = Number(process.env.PBKDF2_ITERATIONS ?? DEFAULT_ITERATIONS);
if (!Number.isInteger(iterations) || iterations < 1) {
  console.error("PBKDF2_ITERATIONS must be a positive integer");
  process.exit(1);
}

console.log(await hashPassword(password, iterations));
