export const OBJECTS = Object.freeze([
  Object.freeze({
    id: 0,
    key: "rod",
    name: "막대",
    symbol: "╱",
    description: "비대칭 색상의 긴 막대",
    inertia: 0.5,
  }),
  Object.freeze({
    id: 1,
    key: "propeller",
    name: "프로펠러",
    symbol: "✣",
    description: "세 개의 날개와 중심 허브",
    inertia: 0.7,
  }),
  Object.freeze({
    id: 2,
    key: "frame",
    name: "사각 프레임",
    symbol: "□",
    description: "네 변과 모서리로 시간 왜곡 관찰",
    inertia: 0.8,
  }),
  Object.freeze({
    id: 3,
    key: "wheel",
    name: "스포크 휠",
    symbol: "⊕",
    description: "바깥 링과 여섯 개의 스포크",
    inertia: 0.6,
  }),
]);
export const SETTINGS_VERSION = 1;
const bounds = {
  angle: [-1e8, 1e8],
  omega: [-1e6, 1e6],
  torque: [-2, 2],
  inertia: [0.05, 2],
  damping: [0, 0.5],
  scanMs: [0, 80],
  exposureMs: [0, 20],
  fov: [30, 150],
  tilt: [0, 65],
  offsetX: [-1.2, 1.2],
  samples: [1, 16],
  simulationTime: [0, 1e9],
};
function number(value, key) {
  const [min, max] = bounds[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${key}: ${min}–${max} 범위의 숫자가 필요합니다.`);
  return value;
}
export function validateSettings(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schemaVersion !== SETTINGS_VERSION ||
    input.experiment !== "shutter-lab"
  )
    throw new Error("Shutter Lab 실험 조건 파일(v1)이 필요합니다.");
  const object = OBJECTS.find((o) => o.key === input.object);
  if (!object) throw new Error("지원하지 않는 실험 물체입니다.");
  const p = input.physics,
    c = input.camera,
    d = input.display;
  if (!p || !c || !d) throw new Error("물리·카메라·화면 설정이 필요합니다.");
  const physics = Object.fromEntries(
    ["angle", "omega", "torque", "inertia", "damping"].map((k) => [
      k,
      number(p[k], k),
    ]),
  );
  const camera = Object.fromEntries(
    ["scanMs", "exposureMs", "fov", "tilt", "offsetX", "samples"].map((k) => [
      k,
      number(c[k], k),
    ]),
  );
  if (![4, 8, 16].includes(camera.samples))
    throw new Error("노출 샘플 수는 4, 8, 16 중 하나여야 합니다.");
  if (!["pinhole", "fisheye"].includes(c.lens))
    throw new Error("렌즈 모델을 확인해 주세요.");
  if (![1, -1].includes(c.direction))
    throw new Error("센서 읽기 방향을 확인해 주세요.");
  camera.lens = c.lens;
  camera.direction = c.direction;
  if (
    ![0.25, 0.5, 1].includes(d.speed) ||
    !["side-by-side", "overlay", "difference"].includes(d.mode) ||
    typeof d.blend !== "number" ||
    !Number.isFinite(d.blend) ||
    d.blend < 0 ||
    d.blend > 1
  )
    throw new Error("화면 비교 설정을 확인해 주세요.");
  return {
    schemaVersion: SETTINGS_VERSION,
    experiment: "shutter-lab",
    object: object.key,
    physics,
    camera,
    display: { speed: d.speed, mode: d.mode, blend: d.blend },
    simulationTime: number(input.simulationTime, "simulationTime"),
  };
}
export function createSettings({
  config,
  state,
  simulationTime,
  speed,
  mode,
  blend,
}) {
  return validateSettings({
    schemaVersion: SETTINGS_VERSION,
    experiment: "shutter-lab",
    object: OBJECTS.find((o) => o.id === config.objectId)?.key,
    physics: {
      angle: state.angle,
      omega: state.omega,
      torque: config.torque,
      inertia: config.inertia,
      damping: config.damping,
    },
    camera: Object.fromEntries(
      [
        "scanMs",
        "exposureMs",
        "fov",
        "tilt",
        "offsetX",
        "samples",
        "lens",
        "direction",
      ].map((k) => [k, config[k]]),
    ),
    display: { speed, mode, blend },
    simulationTime,
  });
}
