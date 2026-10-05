import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  PRESETS,
  advanceRotation,
  kineticEnergy,
  radiansPerSecondToRpm,
  rollingSweepDegrees,
  rotationAtTime,
  rowSampleTime,
  rpmToRadiansPerSecond,
} from "../public/physics.mjs";

function close(actual, expected, tolerance = 1e-11) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} ≉ ${expected}`,
  );
}

test("free rotation preserves angular velocity and kinetic energy", () => {
  const initial = { angle: -2, omega: 11 };
  const next = advanceRotation(initial, 12.5, {
    torque: 0,
    inertia: 0.08,
    damping: 0,
  });
  close(next.angle, -2 + 11 * 12.5);
  close(next.omega, 11);
  close(kineticEnergy(next.omega, 0.08), kineticEnergy(initial.omega, 0.08));
  assert.deepEqual(initial, { angle: -2, omega: 11 });
});

test("constant torque agrees with the angular acceleration solution", () => {
  const angle = 0.7,
    omega = -3,
    dt = 1.6,
    torque = 0.12,
    inertia = 0.04;
  const next = rotationAtTime(angle, omega, dt, torque, inertia, 0);
  const acceleration = torque / inertia;
  close(next.omega, omega + acceleration * dt);
  close(next.angle, angle + omega * dt + (acceleration * dt ** 2) / 2);
});

test("viscous damping agrees with exponential decay and reduces energy", () => {
  const omega = 20,
    inertia = 0.08,
    damping = 0.04,
    dt = 3;
  const next = rotationAtTime(0, omega, dt, 0, inertia, damping);
  const decay = damping / inertia;
  close(next.omega, omega * Math.exp(-decay * dt));
  close(next.angle, (omega * (1 - Math.exp(-decay * dt))) / decay);
  close(
    kineticEnergy(next.omega, inertia) / kineticEnergy(omega, inertia),
    Math.exp(-2 * decay * dt),
  );
});

test("constant torque approaches τ / b equilibrium; equilibrium stays constant", () => {
  const torque = 0.1,
    inertia = 0.04,
    damping = 0.02,
    equilibrium = torque / damping;
  const next = rotationAtTime(1, -4, 3, torque, inertia, damping);
  close(
    next.omega,
    equilibrium + (-4 - equilibrium) * Math.exp((-damping * 3) / inertia),
  );
  const balanced = rotationAtTime(1, equilibrium, 9, torque, inertia, damping);
  close(balanced.omega, equilibrium);
  close(balanced.angle, 1 + equilibrium * 9);
});

test("exact integration composes and supports negative exposure times", () => {
  const properties = { torque: -0.12, inertia: 0.07, damping: 0.013 };
  const initial = { angle: 7, omega: 19 };
  const whole = advanceRotation(initial, 1.7, properties);
  const split = advanceRotation(
    advanceRotation(initial, 0.8, properties),
    0.9,
    properties,
  );
  close(split.angle, whole.angle);
  close(split.omega, whole.omega);
  const restored = advanceRotation(whole, -1.7, properties);
  close(restored.angle, initial.angle);
  close(restored.omega, initial.omega);
});

test("vanishing damping retains the constant acceleration limit", () => {
  for (const dt of [-0.025, 0.025, 2]) {
    const damped = rotationAtTime(2, 8, dt, 0.16, 0.05, 1e-14);
    const limit = rotationAtTime(2, 8, dt, 0.16, 0.05, 0);
    close(damped.angle, limit.angle, 1e-12);
    close(damped.omega, limit.omega, 1e-12);
  }
});

test("row midpoint times are symmetric and reverse with scan direction", () => {
  const height = 100,
    scan = 0.022;
  for (const row of [0, 25, 50, 99]) {
    const time = rowSampleTime(row, height, scan, 0.001, 0, 1, 1);
    close(time, -rowSampleTime(height - 1 - row, height, scan, 0.001, 0, 1, 1));
    close(time, -rowSampleTime(row, height, scan, 0.001, 0, 1, -1));
  }
  close(rowSampleTime(0, height, scan, 0, 0, 1), -0.01089);
  close(rowSampleTime(99, height, scan, 0, 0, 1), 0.01089);
});

test("global shutter shares every row's exposure schedule", () => {
  for (const row of [0, 1, 249, 499]) {
    close(rowSampleTime(row, 500, 0, 0.012, 0, 4), -0.0045);
    close(rowSampleTime(row, 500, 0, 0.012, 3, 4), 0.0045);
    close(rowSampleTime(row, 500, 0, 0, 0, 1), 0);
  }
});

test("exposure samples average to the row's midpoint", () => {
  const times = Array.from({ length: 16 }, (_, sample) =>
    rowSampleTime(70, 100, 0.03, 0.012, sample, 16),
  );
  close(
    times.reduce((sum, value) => sum + value, 0) / times.length,
    rowSampleTime(70, 100, 0.03, 0.012, 0, 1),
  );
  close(times[1] - times[0], 0.012 / 16);
});

test("RPM and angular sweep use physical units rather than pixel displacement", () => {
  close(rpmToRadiansPerSecond(60), 2 * Math.PI);
  close(radiansPerSecondToRpm(rpmToRadiansPerSecond(480)), 480);
  close(rollingSweepDegrees(rpmToRadiansPerSecond(120), 0.022), 15.84);
  close(rollingSweepDegrees(rpmToRadiansPerSecond(-480), 0.035), 100.8);
});

test("invalid physical inputs cannot introduce silent NaN state", () => {
  assert.throws(() => rotationAtTime(0, 1, 1, 0, 0, 0), RangeError);
  assert.throws(() => rotationAtTime(0, 1, 1, 0, 1, -1), RangeError);
  assert.throws(() => rotationAtTime(0, NaN, 1), RangeError);
  assert.throws(() => rowSampleTime(100, 100, 0.02, 0.001, 0, 1), RangeError);
  assert.throws(() => rowSampleTime(0, 100, 0.02, 0.001, 0, 1, 0), RangeError);
});

test("all presets contain complete supported physical and camera controls", () => {
  assert.deepEqual(
    PRESETS.map(({ id }) => id),
    ["baseline", "fast", "fisheye", "blur"],
  );
  for (const preset of PRESETS) {
    for (const field of Object.keys(DEFAULTS)) assert.ok(field in preset);
    assert.ok(["pinhole", "fisheye"].includes(preset.lens));
    assert.ok(preset.inertia > 0);
    assert.ok(preset.samples >= 1);
  }
});
