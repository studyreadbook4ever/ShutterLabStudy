import test from "node:test";
import assert from "node:assert/strict";
import {
  OBJECTS,
  createSettings,
  validateSettings,
} from "../public/settings.mjs";
import { DEFAULTS, rpmToRadiansPerSecond } from "../public/physics.mjs";
const snapshot = () =>
  createSettings({
    config: { ...DEFAULTS, objectId: 0, direction: 1 },
    state: { angle: 0.72, omega: rpmToRadiansPerSecond(120) },
    simulationTime: 1.25,
    speed: 1,
    mode: "side-by-side",
    blend: 0.5,
  });
test("saved experiments round-trip physical state, camera timing, object and display", () => {
  for (const obj of OBJECTS) {
    const s = snapshot();
    s.object = obj.key;
    assert.deepEqual(validateSettings(JSON.parse(JSON.stringify(s))), s);
  }
});
test("saved state strips unrelated fields and rejects incompatible schemas", () => {
  const s = snapshot();
  assert.equal(validateSettings({ ...s, extra: "ignored" }).extra, undefined);
  assert.throws(() => validateSettings({ ...s, schemaVersion: 2 }));
  assert.throws(() => validateSettings({ ...s, object: "unknown" }));
  assert.throws(() => validateSettings([]));
});
test("imported settings reject nonfinite or out-of-UI-range physical and timing values", () => {
  for (const [area, key, value] of [
    ["physics", "inertia", 0],
    ["physics", "omega", Infinity],
    ["camera", "scanMs", 81],
    ["camera", "lens", "unknown"],
    ["camera", "direction", 0],
    ["camera", "samples", 1],
    ["display", "blend", NaN],
    ["display", "speed", 4],
  ]) {
    const s = snapshot();
    s[area][key] = value;
    assert.throws(() => validateSettings(s), `${area}.${key}`);
  }
});
