/** Exact planar rigid-body rotation. Angles are radians and times are seconds. */
export const TAU = Math.PI * 2;
export const rpmToRadiansPerSecond = (rpm) => (rpm * TAU) / 60;
export const radiansPerSecondToRpm = (omega) => (omega * 60) / TAU;

export const DEFAULTS = Object.freeze({
  omegaRpm: 120,
  torque: 0,
  inertia: 0.5,
  damping: 0,
  scanMs: 22,
  exposureMs: 1,
  fov: 65,
  lens: "pinhole",
  tilt: 15,
  offsetX: 0.45,
  samples: 8,
});

export const PRESETS = Object.freeze([
  Object.freeze({
    ...DEFAULTS,
    id: "baseline",
    name: "기본 실험",
    description: "120 RPM · 핀홀 카메라 · 행마다 달라지는 촬영 시각",
  }),
  Object.freeze({
    ...DEFAULTS,
    id: "fast",
    name: "고속 회전",
    description: "480 RPM · 35 ms 판독 · 회전과 판독의 시간차 확대",
    omegaRpm: 480,
    scanMs: 35,
    exposureMs: 0.5,
    fov: 75,
  }),
  Object.freeze({
    ...DEFAULTS,
    id: "fisheye",
    name: "어안 렌즈",
    description: "등거리 어안 투영 · 넓은 시야에서 렌즈와 시간 왜곡 비교",
    omegaRpm: 180,
    scanMs: 28,
    fov: 130,
    lens: "fisheye",
    tilt: 20,
    offsetX: 0.65,
  }),
  Object.freeze({
    ...DEFAULTS,
    id: "blur",
    name: "긴 노출",
    description: "300 RPM · 12 ms 노출 · 회전 궤적을 시간에 걸쳐 누적",
    omegaRpm: 300,
    scanMs: 24,
    exposureMs: 12,
    fov: 75,
    samples: 16,
  }),
]);

function finite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

/**
 * Solve I ω′ = τ − b ω with constant torque, inertia, and viscous damping.
 * Negative dt reconstructs the pose before the frame midpoint. The angle is
 * deliberately unwrapped, so accumulated rotation remains observable.
 */
export function rotationAtTime(
  angle,
  omega,
  dt,
  torque = DEFAULTS.torque,
  inertia = DEFAULTS.inertia,
  damping = DEFAULTS.damping,
) {
  finite(angle, "angle");
  finite(omega, "omega");
  finite(dt, "dt");
  finite(torque, "torque");
  finite(inertia, "inertia");
  finite(damping, "damping");
  if (inertia <= 0) throw new RangeError("inertia must be positive");
  if (damping < 0) throw new RangeError("damping must be nonnegative");
  if (dt === 0) return { angle, omega };

  const decay = damping / inertia;
  const acceleration = torque / inertia - decay * omega;
  if (decay === 0) {
    return {
      angle: angle + omega * dt + (acceleration * dt * dt) / 2,
      omega: omega + acceleration * dt,
    };
  }

  const z = decay * dt;
  const firstIntegral = -Math.expm1(-z) / decay;
  // expm1(-z) + z still cancels for very small z. Its Taylor series
  // preserves the constant-acceleration limit, including backwards time.
  const secondIntegral =
    Math.abs(z) < 1e-4
      ? dt * dt * (0.5 - z / 6 + (z * z) / 24 - z ** 3 / 120 + z ** 4 / 720)
      : (Math.expm1(-z) + z) / (decay * decay);

  return {
    angle: angle + omega * dt + acceleration * secondIntegral,
    omega: omega + acceleration * firstIntegral,
  };
}

export function advanceRotation(
  { angle, omega },
  dt,
  {
    torque = DEFAULTS.torque,
    inertia = DEFAULTS.inertia,
    damping = DEFAULTS.damping,
  } = {},
) {
  return rotationAtTime(angle, omega, dt, torque, inertia, damping);
}

export function kineticEnergy(omega, inertia) {
  finite(omega, "omega");
  finite(inertia, "inertia");
  if (inertia <= 0) throw new RangeError("inertia must be positive");
  return (inertia * omega * omega) / 2;
}

/**
 * A pixel row's exposure sample time relative to the frame midpoint.
 * Rows and samples are zero-based. direction=+1 scans top to bottom;
 * direction=-1 scans bottom to top. Samples use midpoint quadrature.
 * scanSeconds describes a full sensor-height sweep, not the gap between
 * the first and last row centers. Global shutter is scanSeconds=0.
 */
export function rowSampleTime(
  row,
  height,
  scanSeconds,
  exposureSeconds,
  sample,
  samples,
  direction = 1,
) {
  for (const [name, value] of Object.entries({
    row,
    height,
    scanSeconds,
    exposureSeconds,
    sample,
    samples,
    direction,
  }))
    finite(value, name);
  if (!Number.isInteger(height) || height < 1)
    throw new RangeError("height must be a positive integer");
  if (!Number.isInteger(row) || row < 0 || row >= height)
    throw new RangeError("row must address the sensor");
  if (!Number.isInteger(samples) || samples < 1)
    throw new RangeError("samples must be a positive integer");
  if (!Number.isInteger(sample) || sample < 0 || sample >= samples)
    throw new RangeError("sample must address the exposure");
  if (scanSeconds < 0 || exposureSeconds < 0)
    throw new RangeError("timing intervals must be nonnegative");
  if (direction !== 1 && direction !== -1)
    throw new RangeError("direction must be +1 or -1");

  return (
    direction * ((row + 0.5) / height - 0.5) * scanSeconds +
    ((sample + 0.5) / samples - 0.5) * exposureSeconds
  );
}

/** Angular motion during a full scan at the supplied instantaneous speed.
 * This is a physical angular sweep in degrees, never a pixel error metric.
 */
export function rollingSweepDegrees(omega, scanSeconds) {
  finite(omega, "omega");
  finite(scanSeconds, "scanSeconds");
  if (scanSeconds < 0) throw new RangeError("scanSeconds must be nonnegative");
  return (Math.abs(omega) * scanSeconds * 180) / Math.PI;
}
