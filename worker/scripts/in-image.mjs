import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = process.env.LABEL_IMAGE ?? "barcode-wms-labelref";
const PLATFORM = process.env.LABEL_PLATFORM ?? "linux/amd64";

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function docker(args) {
  const result = spawnSync("docker", args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [script, ...scriptArgs] = process.argv.slice(2);
if (!script) {
  console.error("Usage: node scripts/in-image.mjs <script path relative to worker/> [args]");
  process.exit(2);
}
const command = [`worker/${script}`, ...scriptArgs].map(quote).join(" ");
const inner = [
  "set -eu",
  "rm -rf /tmp/build",
  "mkdir -p /tmp/build",
  "cp -R /repo/worker /repo/fonts /repo/public /tmp/build/",
  "rm -rf /tmp/build/worker/node_modules /tmp/build/worker/dist",
  "ln -s /app/node_modules /tmp/build/node_modules",
  "cd /tmp/build",
  `node ${command}`,
  "[ ! -f worker/src/label/atlas.bin ] || cp worker/src/label/atlas.bin /repo/worker/src/label/atlas.bin",
  "if [ -d worker/dist/label-compare ]; then rm -rf /repo/worker/dist/label-compare; cp -R worker/dist/label-compare /repo/worker/dist/; fi",
].join("; ");

docker(["build", "--platform", PLATFORM, "-t", IMAGE, "."]);
docker(["run", "--rm", "--platform", PLATFORM, "--user", "root", "-v", `${ROOT}:/repo`, IMAGE, "sh", "-c", inner]);
