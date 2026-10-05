import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", ".git", "artifacts"]);
const sources = [];
const documents = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(filename);
    else if (entry.isFile() && filename.endsWith(".mjs"))
      sources.push(filename);
    else if (entry.isFile() && filename.endsWith(".md"))
      documents.push(filename);
  }
}

await visit(root);
sources.sort();
documents.sort();
let failed = false;

for (const filename of sources) {
  const checked = spawnSync(process.execPath, ["--check", filename], {
    encoding: "utf8",
  });
  if (checked.status !== 0 || checked.error) {
    failed = true;
    console.error(`Syntax check failed: ${path.relative(root, filename)}`);
    console.error(checked.error?.message || checked.stderr.trim());
  }
}

let links = 0;
for (const filename of documents) {
  // Ignore code fences; check local inline links and image sources.
  const markdown = (await readFile(filename, "utf8")).replace(
    /```[^\n]*\n[\s\S]*?```/g,
    "",
  );
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const destination = match[1]
      .trim()
      .replace(/^<([^>]+)>.*$/, "$1")
      .split(/\s+["']/)[0];
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(destination)) continue;
    const relative = destination.split(/[?#]/, 1)[0];
    if (!relative) continue;
    try {
      await stat(
        path.resolve(path.dirname(filename), decodeURIComponent(relative)),
      );
      links++;
    } catch {
      failed = true;
      console.error(
        `Missing local link in ${path.relative(root, filename)}: ${relative}`,
      );
    }
  }
}

if (failed) process.exitCode = 1;
else
  console.log(
    `Checked ${sources.length} JavaScript modules and ${links} local documentation links.`,
  );
