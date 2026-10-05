import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BINARY = path.join(ROOT, "native/shutter-renderer");
const PORT = Number(process.env.SHUTTER_PORT || 4317);
const HOST = "127.0.0.1";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const ranges = {
  width: [64, 1280],
  height: [64, 960],
  angle: [-1e8, 1e8],
  omega: [-1e6, 1e6],
  torque: [-100, 100],
  inertia: [0.02, 20],
  damping: [0, 5],
  scanMs: [0, 500],
  exposureMs: [0, 500],
  fov: [20, 155],
  tilt: [-75, 75],
  samples: [1, 16],
  offsetX: [-2, 2],
};
let worker,
  buffer = Buffer.alloc(0),
  pending = [],
  active = null,
  backendError = null;
let frames = 0;
const infoResult =
  process.env.SHUTTER_BACKEND === "webgl"
    ? {}
    : spawnSync(BINARY, ["--info"], { encoding: "utf8", timeout: 10000 });
let gpuInfo;
try {
  gpuInfo = JSON.parse(infoResult.stdout);
} catch {
  gpuInfo = { backend: "WebGL2", gpu: null };
}
const nativeAvailable = gpuInfo.backend === "CUDA";

function startWorker() {
  if (worker) return;
  worker = spawn(BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
  const child = worker;
  backendError = null;
  worker.stderr.on("data", (data) => process.stderr.write(data));
  worker.stdin.on("error", (error) => {
    if (worker === child) failWorker(error.message);
  });
  worker.on("error", (error) => {
    if (worker === child) failWorker(error.message);
  });
  worker.on("exit", (code) => {
    if (worker === child) failWorker(`CUDA renderer exited (${code})`);
  });
  worker.stdout.on("data", (data) => {
    if (worker !== child) return;
    buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
    if (!active || buffer.length < 16) return;
    const magic = buffer.readUInt32LE(0),
      length = buffer.readUInt32LE(4);
    if (magic !== 0x53485554 || length !== active.expectedBytes) {
      failWorker("Invalid renderer frame protocol");
      return;
    }
    if (buffer.length < 16 + length) return;
    const result = buffer.subarray(0, 16 + length);
    buffer = buffer.subarray(16 + length);
    const job = active;
    active = null;
    frames++;
    clearTimeout(job.timer);
    job.resolve(result);
    pump();
  });
}

function failWorker(message) {
  backendError = message;
  const old = worker;
  worker = null;
  buffer = Buffer.alloc(0);
  if (old && !old.killed) old.kill();
  if (active) {
    clearTimeout(active.timer);
    active.reject(new Error(message));
    active = null;
  }
  for (const job of pending) job.reject(new Error(message));
  pending = [];
}

function pump() {
  if (active || !pending.length) return;
  startWorker();
  active = pending.shift();
  active.timer = setTimeout(() => failWorker("CUDA render timed out"), 10000);
  worker.stdin.write(active.line + "\n");
}

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("A render request object is required");
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (
      typeof body[key] !== "number" ||
      !Number.isFinite(body[key]) ||
      body[key] < min ||
      body[key] > max
    )
      throw new Error(`Invalid ${key}: expected ${min}–${max}`);
  }
  for (const key of ["width", "height", "samples"])
    if (!Number.isInteger(body[key]))
      throw new Error(`${key} must be an integer`);
  if (!["pinhole", "fisheye"].includes(body.lens))
    throw new Error("Invalid camera lens");
  if (body.direction !== 1 && body.direction !== -1)
    throw new Error("Readout direction must be 1 or -1");
  if (body.objectId === undefined) body.objectId = 0;
  if (
    !Number.isInteger(body.objectId) ||
    body.objectId < 0 ||
    body.objectId > 3
  )
    throw new Error("Invalid object: expected 0–3");
  return body;
}

function render(p) {
  if (pending.length >= 3)
    return Promise.reject(
      Object.assign(new Error("Render queue is full"), { status: 429 }),
    );
  const line = [
    p.width,
    p.height,
    p.angle,
    p.omega,
    p.torque,
    p.inertia,
    p.damping,
    p.scanMs / 1000,
    p.exposureMs / 1000,
    p.fov,
    p.lens === "fisheye" ? 1 : 0,
    p.tilt,
    p.direction,
    p.samples,
    p.offsetX,
    p.objectId,
  ].join(" ");
  return new Promise((resolve, reject) => {
    pending.push({
      line,
      expectedBytes: p.width * p.height * 8,
      resolve,
      reject,
    });
    pump();
  });
}

async function readJson(req) {
  let data = "",
    length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error("Render request is too large");
    data += chunk;
  }
  return JSON.parse(data);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.pathname === "/api/status" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ...gpuInfo,
          native: nativeAvailable,
          frames,
          error: backendError,
        }),
      );
      return;
    }
    if (url.pathname === "/api/render" && req.method === "POST") {
      if (!nativeAvailable) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "CUDA is unavailable. Use the browser WebGL2 renderer.",
          }),
        );
        return;
      }
      let params;
      try {
        params = validate(await readJson(req));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      const frame = await render(params);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", frame.length);
      res.end(frame);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const relative =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname).slice(1);
    const filename = path.resolve(ROOT, "public", relative);
    if (!filename.startsWith(path.join(ROOT, "public") + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const fileStat = await stat(filename);
    if (!fileStat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = await readFile(filename);
    res.setHeader(
      "Content-Type",
      mime[path.extname(filename)] || "application/octet-stream",
    );
    res.setHeader("Content-Length", file.length);
    res.end(req.method === "HEAD" ? undefined : file);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : error.status || 503, {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(PORT, HOST, () =>
  console.log(`Shutter Lab ready at http://${HOST}:${PORT}`),
);
function shutdown() {
  worker?.kill();
  server.close();
  setTimeout(() => process.exit(0), 250).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
