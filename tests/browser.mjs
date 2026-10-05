import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.SHUTTER_TEST_URL || "http://127.0.0.1:4321";
let server, browser;
const errors = [],
  passed = [];
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/status`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Browser-test server failed to start");
}
const executablePath =
  process.env.CHROMIUM_PATH ||
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
try {
  if (!process.env.SHUTTER_TEST_URL)
    server = spawn(process.execPath, ["server.mjs"], {
      cwd: root,
      env: { ...process.env, SHUTTER_PORT: "4321" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  await ready();
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.shutterLab, { timeout: 30000 });
  await page.evaluate(() => window.shutterLab.setPlaying(false));
  async function settled() {
    await page.waitForFunction(
      () => {
        const s = window.shutterLab.getState(),
          f = s.currentFrame;
        return (
          f &&
          f.objectId === s.config.objectId &&
          f.scanMs === s.config.scanMs &&
          f.lens === s.config.lens &&
          f.backend === s.activeBackend &&
          Math.abs(f.angle - s.state.angle) < 1e-5
        );
      },
      { timeout: 30000 },
    );
  }
  async function input(id, value) {
    await page.locator(`#${id}`).evaluate((el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await settled();
  }
  await settled();
  assert.equal(await page.title(), "Shutter Lab — 회전 운동과 카메라 실험실");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  passed.push("desktop render and layout");
  const fingerprints = [];
  for (let id = 0; id < 4; id++) {
    await page.locator(`[data-object="${id}"]`).click();
    await settled();
    const hash = await page.evaluate(() => {
      const c = document.getElementById("global-view"),
        data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < data.length; i += 16)
        h = Math.imul(h ^ data[i], 16777619);
      return h;
    });
    fingerprints.push(hash);
    assert.equal(
      await page.locator(`[data-object="${id}"]`).getAttribute("aria-pressed"),
      "true",
    );
  }
  assert.equal(new Set(fingerprints).size, 4);
  passed.push("four distinct selectable rendered objects");
  await input("scanMs", 0);
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().pixelMae),
    0,
  );
  passed.push("zero-readout image equality");
  await input("scanMs", 40);
  assert.ok(
    (await page.evaluate(() => window.shutterLab.getState().pixelMae)) > 0,
  );
  await page.locator('[data-mode="difference"]').click();
  assert.equal(
    await page.locator("#rolling-title").textContent(),
    "Frame difference",
  );
  await page.locator('[data-mode="overlay"]').click();
  await input("blend", 65);
  assert.equal(await page.locator("#blend-value").textContent(), "65%");
  passed.push("actual-image difference and adjustable overlay");
  await page.locator('[data-lens="fisheye"]').click();
  await settled();
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().currentFrame.lens),
    "fisheye",
  );
  await page.locator('[data-controls="physics"]').click();
  await input("pose-angle", 72);
  assert.ok(
    Math.abs(
      (await page.evaluate(() => window.shutterLab.getState().state.angle)) -
        (72 * Math.PI) / 180,
    ) < 1e-8,
  );
  passed.push("lens and frozen pose controls");
  const before = await page.evaluate(
    () => window.shutterLab.getState().simulationTime,
  );
  await page.locator("#step").click();
  await settled();
  assert.ok(
    Math.abs(
      (await page.evaluate(() => window.shutterLab.getState().simulationTime)) -
        before -
        1 / 60,
    ) < 1e-9,
  );
  passed.push("single-frame physical advance");
  const jsonDownload = page.waitForEvent("download");
  await page.locator("#save-settings").click();
  const jsonFile = await jsonDownload;
  const saved = JSON.parse(await readFile(await jsonFile.path(), "utf8"));
  assert.equal(saved.object, "wheel");
  assert.equal(saved.display.mode, "overlay");
  await page.locator('[data-preset="baseline"]').click();
  await settled();
  await page
    .locator("#settings-file")
    .setInputFiles({
      name: "experiment.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(saved)),
    });
  await settled();
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().config.objectId),
    3,
  );
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().playing),
    false,
  );
  assert.ok(
    Math.abs(
      (await page.evaluate(() => window.shutterLab.getState().state.angle)) -
        saved.physics.angle,
    ) < 1e-8,
  );
  passed.push("JSON export/import restores complete frozen experiment");
  await page
    .locator("#settings-file")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"schemaVersion":99}'),
    });
  await page.waitForFunction(() =>
    document.getElementById("experiment-message").classList.contains("error"),
  );
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().config.objectId),
    3,
  );
  passed.push("invalid import rejected without changing experiment");
  const pngDownload = page.waitForEvent("download");
  await page.locator("#capture").click();
  const pngFile = await pngDownload;
  const png = await readFile(await pngFile.path());
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  passed.push("real PNG capture");
  await page.locator("#theory-open").click();
  assert.equal(
    await page.locator("#theory-dialog").evaluate((e) => e.open),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#theory-dialog").evaluate((e) => e.open),
    false,
  );
  passed.push("accessible theory dialog and Escape");
  await page.locator('[data-mode="side-by-side"]').click();
  await page.locator('[data-preset="fast"]').click();
  await page.locator('[data-object="1"]').click();
  await page.locator('[data-controls="camera"]').click();
  await settled();
  await page.screenshot({
    path: path.join(root, "artifacts/desktop.png"),
    fullPage: true,
  });
  await page.locator("#backend").selectOption("webgl");
  await settled();
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().activeBackend),
    "webgl",
  );
  assert.match(await page.locator("#engine-name").textContent(), /WEBGL2/);
  await input("scanMs", 0);
  assert.equal(
    await page.evaluate(() => window.shutterLab.getState().pixelMae),
    0,
  );
  passed.push("explicit WebGL2 fallback and correct backend label/equality");
  await page.screenshot({
    path: path.join(root, "artifacts/webgl.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await settled();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator('[data-object="2"]').click();
  await settled();
  await page.screenshot({
    path: path.join(root, "artifacts/mobile.png"),
    fullPage: true,
  });
  passed.push("mobile layout and object interaction");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { passed, checks: passed.length, pageErrors: errors },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server?.kill();
}
