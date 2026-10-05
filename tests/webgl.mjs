import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (
  process.env.SHUTTER_TEST_URL || "http://127.0.0.1:4322"
).replace(/\/$/, "");
let ownServer, browser;

async function startServer() {
  ownServer = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, SHUTTER_PORT: "4322", SHUTTER_BACKEND: "webgl" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  ownServer.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-8192);
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(`WebGL test server did not become ready: ${output}`)),
      10000,
    );
    const finish = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };
    ownServer.once("error", (error) => finish(reject, error));
    ownServer.once("exit", (code) =>
      finish(
        reject,
        new Error(`WebGL test server exited (${code}): ${output}`),
      ),
    );
    ownServer.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-8192);
      if (output.includes("Shutter Lab ready at")) finish(resolve);
    });
  });
  const status = await fetch(`${BASE_URL}/api/status`, {
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  assert.equal(
    status.backend,
    "WebGL2",
    "test server must not require NVIDIA or launch CUDA",
  );
  assert.equal(status.native, false);
}

async function executablePath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    await access("/usr/bin/chromium");
    return "/usr/bin/chromium";
  } catch {
    return undefined;
  }
}

async function cleanup() {
  try {
    await browser?.close();
  } finally {
    if (
      ownServer &&
      ownServer.exitCode === null &&
      ownServer.signalCode === null
    ) {
      const exited = once(ownServer, "exit");
      ownServer.kill("SIGTERM");
      let timeout;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timeout = setTimeout(resolve, 2000);
        }),
      ]);
      clearTimeout(timeout);
      if (ownServer.exitCode === null && ownServer.signalCode === null) {
        ownServer.kill("SIGKILL");
        await exited;
      }
    }
  }
}

try {
  if (!process.env.SHUTTER_TEST_URL) await startServer();
  browser = await chromium.launch({
    executablePath: await executablePath(),
    headless: true,
    timeout: 20000,
    args: [
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Use the actual origin and modules, isolating engine tests from UI playback.
  await page.route("**/__qa_webgl", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
    }),
  );
  await page.goto(`${BASE_URL}/__qa_webgl`, { timeout: 10000 });
  const result = await page.evaluate(async () => {
    const { WebGLRenderer } = await import("/webgl-renderer.mjs");
    const canvas = document.createElement("canvas");
    const renderer = new WebGLRenderer(canvas);
    const base = {
      width: 128,
      height: 96,
      angle: 0.65,
      omega: 32,
      torque: 0,
      inertia: 0.5,
      damping: 0,
      scanMs: 70,
      exposureMs: 0,
      fov: 55,
      lens: "pinhole",
      tilt: 15,
      direction: 1,
      samples: 1,
      offsetX: 0.45,
      objectId: 0,
      rolling: false,
    };
    const draw = (params = {}) => {
      const stats = renderer.render({ ...base, ...params });
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      renderer.gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        renderer.gl.RGBA,
        renderer.gl.UNSIGNED_BYTE,
        pixels,
      );
      return { stats, pixels };
    };
    const difference = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 4)
        for (let channel = 0; channel < 3; channel++)
          sum += Math.abs(a[i + channel] - b[i + channel]);
      return sum / ((a.length / 4) * 3);
    };
    const stationaryGlobal = draw({ omega: 0, exposureMs: 25, samples: 4 });
    const stationaryRolling = draw({
      omega: 0,
      exposureMs: 25,
      samples: 4,
      rolling: true,
    });
    const zeroGlobal = draw({
      scanMs: 0,
      exposureMs: 20,
      samples: 4,
      torque: 0.2,
      damping: 0.05,
    });
    const zeroRolling = draw({
      scanMs: 0,
      exposureMs: 20,
      samples: 4,
      torque: 0.2,
      damping: 0.05,
      rolling: true,
    });
    const global = draw(),
      forward = draw({ rolling: true });
    const backward = draw({ rolling: true, direction: -1 });
    const reverseMotion = draw({ rolling: true, omega: -32 });
    const sharp = draw({ omega: 40 }),
      blur = draw({ omega: 40, exposureMs: 45, samples: 8 });
    const pinhole = draw({ omega: 0, fov: 105 }),
      fisheye = draw({ omega: 0, fov: 105, lens: "fisheye" });
    const fast = draw({ omega: 512, scanMs: 20, rolling: true });
    const longerReadout = draw({ omega: 256, scanMs: 40, rolling: true });
    const objects = [],
      objectImages = [];
    for (let objectId = 0; objectId < 4; objectId++) {
      const stationary = draw({
        objectId,
        omega: 0,
        exposureMs: 20,
        samples: 4,
      });
      const stationaryRoll = draw({
        objectId,
        omega: 0,
        exposureMs: 20,
        samples: 4,
        rolling: true,
      });
      const noScan = draw({
        objectId,
        scanMs: 0,
        exposureMs: 20,
        samples: 4,
        torque: 0.2,
        damping: 0.03,
      });
      const noScanRoll = draw({
        objectId,
        scanMs: 0,
        exposureMs: 20,
        samples: 4,
        torque: 0.2,
        damping: 0.03,
        rolling: true,
      });
      const midpoint = draw({ objectId }),
        moving = draw({ objectId, rolling: true });
      const tilted = draw({ objectId, omega: 0, tilt: 65 });
      let bright = 0;
      for (let i = 0; i < tilted.pixels.length; i += 4)
        if (
          Math.max(
            tilted.pixels[i],
            tilted.pixels[i + 1],
            tilted.pixels[i + 2],
          ) > 150
        )
          bright++;
      objects.push({
        objectId,
        stationaryError: difference(stationary.pixels, stationaryRoll.pixels),
        zeroScanError: difference(noScan.pixels, noScanRoll.pixels),
        movingDifference: difference(midpoint.pixels, moving.pixels),
        brightAt65Degrees: bright,
      });
      objectImages.push(stationary.pixels);
    }
    const distinctObjects = [];
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++)
        distinctObjects.push({
          a,
          b,
          difference: difference(objectImages[a], objectImages[b]),
        });

    // Copy the GL canvas into 2D just as the UI does. The orange positive end
    // of a rod at angle +0.65 must appear above and right of the image center.
    draw({ omega: 0 });
    const visible = document.createElement("canvas");
    visible.width = base.width;
    visible.height = base.height;
    const context = visible.getContext("2d");
    context.drawImage(canvas, 0, 0);
    const image = context.getImageData(0, 0, base.width, base.height).data;
    let orangeX = 0,
      orangeY = 0,
      orangeCount = 0;
    for (let y = 0; y < base.height; y++)
      for (let x = 0; x < base.width; x++) {
        const i = (y * base.width + x) * 4;
        if (
          image[i] > 100 &&
          image[i] > image[i + 1] * 1.5 &&
          image[i] > image[i + 2] * 1.5
        ) {
          orangeX += x;
          orangeY += y;
          orangeCount++;
        }
      }
    const extreme = draw({
      omega: 1e6,
      inertia: 0.02,
      damping: 5,
      scanMs: 500,
      exposureMs: 500,
      samples: 16,
      rolling: true,
    });
    let nonopaque = 0,
      maximumRgb = 0;
    for (let i = 0; i < extreme.pixels.length; i += 4) {
      if (extreme.pixels[i + 3] !== 255) nonopaque++;
      maximumRgb = Math.max(
        maximumRgb,
        extreme.pixels[i],
        extreme.pixels[i + 1],
        extreme.pixels[i + 2],
      );
    }
    const invalidErrors = [];
    for (const invalid of [
      { objectId: 4 },
      { samples: 0 },
      { inertia: 0 },
      { direction: 0 },
    ]) {
      try {
        renderer.render({ ...base, ...invalid });
        invalidErrors.push(false);
      } catch (error) {
        invalidErrors.push(error instanceof RangeError);
      }
    }
    renderer.dispose();
    let disposedError = "";
    try {
      renderer.render(base);
    } catch (error) {
      disposedError = error.message;
    }
    let capabilityError = "";
    try {
      new WebGLRenderer({
        getContext() {
          return null;
        },
      });
    } catch (error) {
      capabilityError = error.message;
    }
    return {
      backend: global.stats.backend,
      renderMs: global.stats.renderMs,
      stationaryError: difference(
        stationaryGlobal.pixels,
        stationaryRolling.pixels,
      ),
      zeroScanError: difference(zeroGlobal.pixels, zeroRolling.pixels),
      rollingDifference: difference(global.pixels, forward.pixels),
      directionDifference: difference(forward.pixels, backward.pixels),
      reversedTimeError: difference(backward.pixels, reverseMotion.pixels),
      speedScalingError: difference(fast.pixels, longerReadout.pixels),
      exposureDifference: difference(sharp.pixels, blur.pixels),
      lensDifference: difference(pinhole.pixels, fisheye.pixels),
      objects,
      distinctObjects,
      orangeCentroid: {
        x: orangeX / orangeCount,
        y: orangeY / orangeCount,
        count: orangeCount,
      },
      extreme: { nonopaque, maximumRgb, renderMs: extreme.stats.renderMs },
      invalidErrors,
      disposedError,
      capabilityError,
    };
  });
  assert.equal(result.backend, "WebGL2");
  assert.ok(Number.isFinite(result.renderMs) && result.renderMs >= 0);
  assert.equal(result.stationaryError, 0);
  assert.equal(result.zeroScanError, 0);
  assert.ok(result.rollingDifference > 0.5);
  assert.ok(result.directionDifference > 0.5);
  assert.equal(result.reversedTimeError, 0);
  assert.equal(result.speedScalingError, 0);
  assert.ok(result.exposureDifference > 0.3);
  assert.ok(result.lensDifference > 1);
  for (const object of result.objects) {
    assert.equal(
      object.stationaryError,
      0,
      `stationary object ${object.objectId}`,
    );
    assert.equal(
      object.zeroScanError,
      0,
      `zero scan object ${object.objectId}`,
    );
    assert.ok(
      object.movingDifference > 0.35,
      `moving object ${object.objectId}`,
    );
    assert.ok(
      object.brightAt65Degrees > 50,
      `visible tilted object ${object.objectId}`,
    );
  }
  for (const pair of result.distinctObjects)
    assert.ok(
      pair.difference > 0.35,
      `distinct objects ${pair.a} and ${pair.b}`,
    );
  assert.ok(
    result.orangeCentroid.x > 64 &&
      result.orangeCentroid.y < 48 &&
      result.orangeCentroid.count > 50,
    "GL-to-2D copy must preserve physical top-down camera orientation",
  );
  assert.equal(result.extreme.nonopaque, 0);
  assert.ok(
    result.extreme.maximumRgb > 100,
    "extreme trajectory must remain visible",
  );
  assert.ok(Number.isFinite(result.extreme.renderMs));
  assert.ok(result.invalidErrors.every(Boolean));
  assert.match(result.disposedError, /disposed/);
  assert.match(result.capabilityError, /WebGL2/);
  assert.deepEqual(errors, []);
  console.log(`WebGL2 physical verification passed against ${BASE_URL}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await cleanup();
}
