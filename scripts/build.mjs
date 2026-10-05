import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const steps = [["node", ["scripts/verify.mjs"]]];
for (const [cmd, args] of steps) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  "Shutter Lab browser source ready. Optional CUDA build: npm run build:cuda",
);
