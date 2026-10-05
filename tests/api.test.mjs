import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.SHUTTER_TEST_URL || "http://127.0.0.1:4317";
const BASE = Object.freeze({
  width: 192,
  height: 160,
  angle: 0.65,
  omega: 32,
  torque: 0,
  inertia: 0.08,
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
});

async function request(body, raw = false) {
  return fetch(`${BASE_URL}/api/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

async function render(overrides = {}) {
  const params = { ...BASE, ...overrides };
  const response = await request(params);
  if (response.status !== 200)
    assert.fail(`${response.status}: ${(await response.text()).slice(0, 200)}`);
  assert.match(
    response.headers.get("Content-Type"),
    /^application\/octet-stream/,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const panelLength = params.width * params.height * 4;
  assert.equal(bytes.length, 16 + panelLength * 2, "two exact RGBA panels");
  assert.equal(bytes.readUInt32LE(0), 0x53485554, "native wire magic");
  assert.equal(bytes.readUInt32LE(4), panelLength * 2, "native payload length");
  assert.equal(bytes.readUInt32LE(12), 1, "CUDA backend, no CPU fallback");
  const kernelMs = bytes.readFloatLE(8);
  assert.ok(
    Number.isFinite(kernelMs) && kernelMs > 0 && kernelMs < 10000,
    `finite positive CUDA event duration: ${kernelMs}`,
  );
  const global = bytes.subarray(16, 16 + panelLength);
  const rolling = bytes.subarray(16 + panelLength);
  for (let i = 3; i < panelLength; i += 4) {
    assert.equal(global[i], 255, "global pixel alpha");
    assert.equal(rolling[i], 255, "rolling pixel alpha");
  }
  return { global, rolling, kernelMs, params };
}

function meanDifference(a, b) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum +=
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3);
}

test("status identifies the actual native CUDA GPU and protocol", async () => {
  const response = await fetch(`${BASE_URL}/api/status`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.backend, "CUDA");
  assert.equal(status.backendId, 1);
  assert.equal(status.native, true);
  assert.equal(status.protocolVersion, 1);
  assert.ok(typeof status.gpu === "string" && status.gpu.length > 0);
  assert.ok(status.runtimeVersion > 0 && status.driverVersion > 0);
  assert.match(status.computeCapability, /^\d+\.\d+$/);
  assert.equal(status.error, null);
});

test("stationary scene remains identical under rolling readout and exposure", async () => {
  const frame = await render({
    omega: 0,
    scanMs: 120,
    exposureMs: 35,
    samples: 8,
  });
  assert.deepEqual(frame.global, frame.rolling);
  let brightPixels = 0;
  for (let i = 0; i < frame.global.length; i += 4) {
    if (
      Math.max(frame.global[i], frame.global[i + 1], frame.global[i + 2]) > 150
    )
      brightPixels++;
  }
  assert.ok(brightPixels > 100, "nonblank illuminated rod and motor");
});

test("zero readout keeps both panels identical with torque, damping, and motion blur", async () => {
  const frame = await render({
    scanMs: 0,
    exposureMs: 30,
    samples: 16,
    torque: 0.12,
    damping: 0.016,
  });
  assert.deepEqual(frame.global, frame.rolling);
});

test("a moving physical rod produces measurable rolling shutter distortion", async () => {
  const frame = await render();
  assert.ok(
    meanDifference(frame.global, frame.rolling) > 0.5,
    "row-dependent timestamps must visibly change the image",
  );
});

test("readout reversal changes rolling image, preserves global pose, and reverses time correctly", async () => {
  const forward = await render({ direction: 1 });
  const backward = await render({ direction: -1 });
  const reversedMotion = await render({ direction: 1, omega: -BASE.omega });
  assert.deepEqual(
    forward.global,
    backward.global,
    "same frame midpoint state",
  );
  assert.ok(meanDifference(forward.rolling, backward.rolling) > 0.5);
  assert.deepEqual(
    backward.rolling,
    reversedMotion.rolling,
    "for free rotation, reversing row time equals reversing angular velocity",
  );
});

test("angular velocities above 250 rad/s retain the correct speed-times-readout relationship", async () => {
  const fast = await render({ omega: 512, scanMs: 20 });
  const longerReadout = await render({ omega: 256, scanMs: 40 });
  assert.deepEqual(fast.global, longerReadout.global, "same midpoint pose");
  assert.deepEqual(
    fast.rolling,
    longerReadout.rolling,
    "free-rotation observations depend on omega times row time without clipping",
  );
});

test("finite exposure integrates different physical poses in the global shutter image", async () => {
  const sharp = await render({
    scanMs: 0,
    omega: 40,
    exposureMs: 0,
    samples: 1,
  });
  const blurred = await render({
    scanMs: 0,
    omega: 40,
    exposureMs: 45,
    samples: 16,
  });
  assert.deepEqual(blurred.global, blurred.rolling);
  assert.ok(
    meanDifference(sharp.global, blurred.global) > 0.3,
    "temporal integration must visibly change the same midpoint pose",
  );
});

test("pinhole and equidistant fisheye project the same stationary world differently", async () => {
  const camera = { omega: 0, fov: 105, tilt: 25, offsetX: 0.8 };
  const pinhole = await render({ ...camera, lens: "pinhole" });
  const fisheye = await render({ ...camera, lens: "fisheye" });
  assert.deepEqual(pinhole.global, pinhole.rolling);
  assert.deepEqual(fisheye.global, fisheye.rolling);
  assert.ok(
    meanDifference(pinhole.global, fisheye.global) > 1,
    "lens projection must affect fixed world geometry as well as the rod",
  );
});

test("every rigid object obeys shutter invariants and has a distinct silhouette", async (t) => {
  const silhouettes = [];
  for (let objectId = 0; objectId < 4; objectId++) {
    await t.test(
      `object ${objectId}: stationary, zero scan, and moving`,
      async () => {
        const stationary = await render({
          objectId,
          omega: 0,
          exposureMs: 20,
          samples: 4,
        });
        assert.deepEqual(stationary.global, stationary.rolling);
        const noScan = await render({
          objectId,
          scanMs: 0,
          exposureMs: 20,
          samples: 4,
          torque: 0.2,
          damping: 0.03,
        });
        assert.deepEqual(noScan.global, noScan.rolling);
        const moving = await render({ objectId });
        assert.ok(
          meanDifference(moving.global, moving.rolling) > 0.35,
          `object ${objectId} must respond to row-dependent observation time`,
        );
        const mask = new Uint8Array(BASE.width * BASE.height);
        for (let i = 0; i < mask.length; i++) {
          const offset = i * 4;
          mask[i] =
            Math.max(
              stationary.global[offset],
              stationary.global[offset + 1],
              stationary.global[offset + 2],
            ) > 150
              ? 1
              : 0;
        }
        silhouettes.push(mask);
      },
    );
  }
  for (let a = 0; a < silhouettes.length; a++)
    for (let b = a + 1; b < silhouettes.length; b++) {
      let distinctPixels = 0;
      for (let i = 0; i < silhouettes[a].length; i++)
        if (silhouettes[a][i] !== silhouettes[b][i]) distinctPixels++;
      assert.ok(
        distinctPixels > 50,
        `objects ${a} and ${b} must have distinct foreground silhouettes`,
      );
    }
});

test("omitting the optional object ID preserves the original rod request", async () => {
  const explicit = await render({ objectId: 0 });
  const implicit = await render({ objectId: undefined });
  assert.deepEqual(explicit.global, implicit.global);
  assert.deepEqual(explicit.rolling, implicit.rolling);
});

test("invalid requests return 400 and a following valid render succeeds", async () => {
  const invalid = [
    { ...BASE, width: 0 },
    { ...BASE, width: 192.5 },
    { ...BASE, inertia: 0 },
    { ...BASE, damping: -1 },
    { ...BASE, samples: 17 },
    { ...BASE, direction: 0 },
    { ...BASE, lens: "unknown" },
    { ...BASE, fov: 156 },
    { ...BASE, height: "160" },
    { ...BASE, angle: null },
    { ...BASE, scanMs: -1 },
    null,
    { ...BASE, objectId: -1 },
    { ...BASE, objectId: 4 },
    { ...BASE, objectId: 1.5 },
    { ...BASE, objectId: "1" },
    { ...BASE, objectId: null },
  ];
  for (const body of invalid) {
    const response = await request(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }
  const malformed = await request("{broken", true);
  assert.equal(malformed.status, 400);
  await render({ angle: 1.2 });
});

test("bounded concurrent requests preserve frame order and recover after image reallocations", async () => {
  const requests = [
    { width: 96, height: 80, angle: 0.3 },
    { width: 128, height: 96, angle: 1.1 },
    { width: 192, height: 160, angle: 2.4 },
  ];
  const queued = await Promise.all(requests.map((params) => render(params)));
  const reference = await render(requests[1]);
  assert.deepEqual(queued[1].global, reference.global);
  assert.deepEqual(queued[1].rolling, reference.rolling);
  const status = await fetch(`${BASE_URL}/api/status`, {
    signal: AbortSignal.timeout(10000),
  }).then((response) => response.json());
  assert.equal(status.error, null);
  assert.ok(status.frames >= 3);
});
