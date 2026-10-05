import {
  advanceRotation,
  rotationAtTime,
  kineticEnergy,
  PRESETS,
  rpmToRadiansPerSecond,
  radiansPerSecondToRpm,
} from "./physics.mjs";
import { OBJECTS, createSettings, validateSettings } from "./settings.mjs";
import { WebGLRenderer } from "./webgl-renderer.mjs";

const $ = (id) => document.getElementById(id);
const globalCanvas = $("global-view"),
  rollingCanvas = $("rolling-view");
const globalContext = globalCanvas.getContext("2d"),
  rollingContext = rollingCanvas.getContext("2d");
const controls = [
  "rpm",
  "torque",
  "inertia",
  "damping",
  "scanMs",
  "exposureMs",
  "fov",
  "tilt",
  "offsetX",
  "direction",
  "samples",
];
let config = { objectId: 0 },
  state = { angle: 0.72, omega: rpmToRadiansPerSecond(120) };
let playing = true,
  speed = 1,
  simulationTime = 0,
  activePreset = "baseline",
  revision = 0;
let lastTime = performance.now(),
  lastRenderTime = 0,
  renderedRevision = -1,
  inflight = false;
let errorCount = 0,
  kernelMs = null,
  imageFps = 0,
  frameCount = 0,
  lastMetricsTime = 0;
let history = [],
  lastHistoryTime = 0,
  currentFrame = null;
let nativeAvailable = false,
  activeBackend = "cuda",
  gpuName = "",
  webglGlobal,
  webglRolling,
  mode = "side-by-side",
  blend = 0.5;
let rawGlobal = null,
  rawRolling = null,
  pixelMae = 0;
const webglReadback = document.createElement("canvas"),
  webglReadbackContext = webglReadback.getContext("2d", {
    willReadFrequently: true,
  });
const formats = {
  rpm: [0, "rpm"],
  torque: [2, "N·m"],
  inertia: [2, "kg·m²"],
  damping: [2, "N·m·s"],
  scanMs: [0, "ms"],
  exposureMs: [1, "ms"],
  fov: [0, "°"],
  tilt: [0, "°"],
  offsetX: [2, "m"],
};

function setPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  config = { ...preset, objectId: config.objectId ?? 0 };
  activePreset = id;
  for (const key of controls) {
    const value =
      key === "rpm" ? preset.omegaRpm : key === "direction" ? 1 : preset[key];
    $(key).value = value ?? (key === "samples" ? 8 : 0);
  }
  config.direction = 1;
  config.samples = Number($("samples").value);
  state = { angle: 0.72, omega: rpmToRadiansPerSecond(preset.omegaRpm) };
  simulationTime = 0;
  history = [];
  lastHistoryTime = 0;
  revision++;
  $("experiment-message").hidden = true;
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.classList.toggle("active", b.dataset.preset === id);
    b.setAttribute("aria-pressed", String(b.dataset.preset === id));
  });
  syncControls();
  updateMetrics();
  drawTiming();
}

function syncControls() {
  for (const [key, [digits, unit]] of Object.entries(formats)) {
    const input = $(key),
      value = Number(input.value);
    $(`${key}-value`).innerHTML =
      `${value.toFixed(digits)} <small>${unit}</small>`;
    input.style.setProperty(
      "--fill",
      `${(100 * (value - Number(input.min))) / (Number(input.max) - Number(input.min))}%`,
    );
  }
  document.querySelectorAll("[data-lens]").forEach((b) => {
    b.classList.toggle("active", b.dataset.lens === config.lens);
    b.setAttribute("aria-pressed", String(b.dataset.lens === config.lens));
  });
  document.querySelectorAll("[data-object]").forEach((b) => {
    const selected = Number(b.dataset.object) === config.objectId;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  $("object-name").textContent = OBJECTS.find(
    (o) => o.id === config.objectId,
  ).name;
  const lensText = `${config.lens === "fisheye" ? "EQUIDISTANT" : "PINHOLE"} · ${config.fov}°`;
  $("global-lens").textContent = $("rolling-lens").textContent = lensText;
  $("global-exposure").textContent =
    `EXPOSURE ${config.exposureMs.toFixed(1)} ms`;
  $("rolling-scan").textContent = `SCAN ${config.scanMs} ms`;
  $("readout-direction").textContent =
    `READOUT ${config.direction === 1 ? "↓" : "↑"}`;
  $("readout-line").querySelector("span").textContent = "t = 0";
  let insight;
  if (config.scanMs === 0)
    insight =
      "읽기 시간이 0이면 두 셔터의 촬영 시각이 같아집니다. 두 영상이 정확히 일치하는지 확인해 보세요.";
  else if (config.lens === "fisheye")
    insight =
      "배경 격자까지 휘는 것은 렌즈 투영의 영향입니다. 읽기 시간을 0으로 내려 시간 왜곡과 분리해 보세요.";
  else if (config.exposureMs >= 8)
    insight =
      "한 행을 노출하는 동안에도 막대가 움직입니다. 노출을 줄이면 흐림이 줄지만, 행 사이 시간차는 유지됩니다.";
  else if (Math.abs(config.torque) > 0.01 || config.damping > 0.001)
    insight =
      "시간이 흐르며 회전 속도가 바뀝니다. 토크와 감쇠를 조절하고, 각속도와 셔터 왜곡이 함께 변하는지 관찰해 보세요.";
  else
    insight =
      "센서 읽기 시간을 늘려보세요. 더 오래 읽는 동안 막대가 더 많이 회전합니다. 방향을 뒤집으면 행의 시간 순서도 뒤집힙니다.";
  $("insight-text").textContent = insight;
}

for (const key of controls)
  $(key).addEventListener("input", () => {
    const value = Number($(key).value);
    if (key === "rpm") {
      config.omegaRpm = value;
      state.omega = rpmToRadiansPerSecond(value);
    } else config[key] = value;
    revision++;
    syncControls();
    updateMetrics();
    drawTiming();
  });
document
  .querySelectorAll("[data-preset]")
  .forEach((b) =>
    b.addEventListener("click", () => setPreset(b.dataset.preset)),
  );
document.querySelectorAll("[data-lens]").forEach((b) =>
  b.addEventListener("click", () => {
    config.lens = b.dataset.lens;
    revision++;
    syncControls();
    drawTiming();
  }),
);
document.querySelectorAll("[data-object]").forEach((b) =>
  b.addEventListener("click", () => {
    const object = OBJECTS.find((o) => o.id === Number(b.dataset.object));
    config.objectId = object.id;
    config.inertia = object.inertia;
    $("inertia").value = object.inertia;
    revision++;
    syncControls();
    updateMetrics();
  }),
);
document.querySelectorAll("[data-controls]").forEach((b) =>
  b.addEventListener("click", () => {
    const physics = b.dataset.controls === "physics";
    $("physics-controls").hidden = !physics;
    $("camera-controls").hidden = physics;
    document.querySelectorAll("[data-controls]").forEach((button) => {
      const selected = button === b;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }),
);
$("pose-angle").addEventListener("input", () => {
  setPlaying(false);
  state.angle = (Number($("pose-angle").value) * Math.PI) / 180;
  revision++;
  updateMetrics();
});
$("reset").addEventListener("click", () => setPreset(activePreset));
function setPlaying(value) {
  if (playing !== value) revision++;
  playing = value;
  lastTime = performance.now();
  $("play-symbol").textContent = value ? "Ⅱ" : "▶";
  $("play-label").textContent = value ? "일시정지" : "재생";
  $("play").setAttribute(
    "aria-label",
    value ? "시뮬레이션 일시정지" : "시뮬레이션 재생",
  );
  $("frame-state").textContent = value ? "실시간 렌더링" : "프레임 고정";
}
$("play").addEventListener("click", () => setPlaying(!playing));
$("step").addEventListener("click", () => {
  setPlaying(false);
  state = advanceRotation(state, 1 / 60, config);
  simulationTime += 1 / 60;
  revision++;
  updateMetrics();
});
$("playback-speed").addEventListener("change", () => {
  speed = Number($("playback-speed").value);
});
$("theory-open").addEventListener("click", () => {
  $("theory-dialog").showModal();
});
$("theory-close").addEventListener("click", () => {
  $("theory-dialog").close();
});
$("theory-dialog").addEventListener("click", (e) => {
  if (e.target === $("theory-dialog")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
document.addEventListener("keydown", (e) => {
  if (
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
      document.activeElement?.tagName,
    ) ||
    $("theory-dialog").open
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    setPlaying(!playing);
  }
  if (e.code === "KeyR") {
    setPreset(activePreset);
  }
  if (e.code === "ArrowRight") {
    e.preventDefault();
    $("step").click();
  }
});

function updateMetrics() {
  $("live-rpm").textContent = radiansPerSecondToRpm(state.omega).toFixed(1);
  const pose = ((((state.angle * 180) / Math.PI) % 360) + 360) % 360;
  $("pose-angle").value = pose;
  $("pose-angle-value").innerHTML = `${pose.toFixed(1)} <small>°</small>`;
  $("pose-angle").style.setProperty("--fill", `${pose / 3.6}%`);
  const sampleAngle = (dt) =>
    rotationAtTime(
      state.angle,
      state.omega,
      dt,
      config.torque,
      config.inertia,
      config.damping,
    ).angle;
  const sweep = (seconds) =>
    (Math.abs(sampleAngle(seconds / 2) - sampleAngle(-seconds / 2)) * 180) /
    Math.PI;
  $("sweep-value").textContent = sweep(config.scanMs / 1000).toFixed(2);
  $("blur-value").textContent = sweep(config.exposureMs / 1000).toFixed(2);
  $("alpha-value").innerHTML =
    `${((config.torque - config.damping * state.omega) / config.inertia).toFixed(2)} <small>rad/s²</small>`;
  $("energy-value").innerHTML =
    `${kineticEnergy(state.omega, config.inertia).toFixed(2)} <small>J</small>`;
  const minutes = Math.floor(simulationTime / 60),
    seconds = Math.floor(simulationTime % 60),
    ms = Math.floor((simulationTime % 1) * 1000);
  $("timecode").textContent =
    `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  if (kernelMs !== null) $("kernel-ms").textContent = kernelMs.toFixed(2);
  if (simulationTime - lastHistoryTime > 0.1 || !history.length) {
    history.push(state.omega);
    if (history.length > 48) history.shift();
    lastHistoryTime = simulationTime;
  }
  const max = Math.max(...history, 1),
    min = Math.min(...history, 0),
    range = Math.max(max - min, 1);
  $("speed-sparkline").setAttribute(
    "d",
    history
      .map(
        (v, i) =>
          `${i ? "L" : "M"}${((i / Math.max(history.length - 1, 1)) * 95).toFixed(1)} ${(26 - ((v - min) / range) * 20).toFixed(1)}`,
      )
      .join(" "),
  );
}

function drawTiming() {
  const canvas = $("timing-chart"),
    rect = canvas.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2);
  if (!rect.width) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = rect.width,
    h = rect.height,
    left = 42,
    right = w - 17,
    top = 17,
    bottom = h - 29;
  const extent = Math.max(8, config.scanMs / 2 + config.exposureMs / 2 + 3),
    x = (t) => left + ((t + extent) / (extent * 2)) * (right - left);
  ctx.font = "10px ui-monospace, monospace";
  ctx.lineWidth = 1;
  ctx.textAlign = "center";
  for (let i = -2; i <= 2; i++) {
    const t = (i * extent) / 2,
      xx = x(t);
    ctx.strokeStyle = i === 0 ? "#3d495a" : "#273240";
    ctx.beginPath();
    ctx.moveTo(xx, top - 5);
    ctx.lineTo(xx, bottom + 5);
    ctx.stroke();
    ctx.fillStyle = "#7a8ca2";
    ctx.fillText(`${t.toFixed(0)}`, xx, h - 9);
  }
  ctx.textAlign = "right";
  for (const [v, label] of [
    [0, "위"],
    [0.5, "중앙"],
    [1, "아래"],
  ]) {
    const y = top + (bottom - top) * v;
    ctx.fillStyle = "#7a8ca2";
    ctx.fillText(label, left - 11, y + 3);
    ctx.strokeStyle = "#273240";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#7a8ca2";
  ctx.textAlign = "right";
  ctx.fillText("ms", w - 1, h - 9);
  const half = config.scanMs / 2,
    exp = config.exposureMs / 2;
  ctx.fillStyle = "#ffa26717";
  ctx.fillRect(x(-exp), top, x(exp) - x(-exp), bottom - top);
  ctx.fillStyle = "#a2cba71c";
  ctx.beginPath();
  ctx.moveTo(x(-config.direction * half - exp), top);
  ctx.lineTo(x(config.direction * half - exp), bottom);
  ctx.lineTo(x(config.direction * half + exp), bottom);
  ctx.lineTo(x(-config.direction * half + exp), top);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#ff9c67";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(0), top);
  ctx.lineTo(x(0), bottom);
  ctx.stroke();
  ctx.strokeStyle = "#a2cba7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(-config.direction * half), top);
  ctx.lineTo(x(config.direction * half), bottom);
  ctx.stroke();
  for (const t of [0, 1]) {
    ctx.fillStyle = "#a2cba7";
    ctx.beginPath();
    ctx.arc(
      x((t ? 1 : -1) * config.direction * half),
      top + (bottom - top) * t,
      3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}
new ResizeObserver(() => {
  drawTiming();
  revision++;
}).observe($("timing-chart"));

function paintPair() {
  if (!rawGlobal || !rawRolling) return;
  const a = rawGlobal.data,
    b = rawRolling.data,
    w = rawGlobal.width,
    h = rawGlobal.height;
  globalContext.putImageData(rawGlobal, 0, 0);
  if (mode === "side-by-side") rollingContext.putImageData(rawRolling, 0, 0);
  else {
    const out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
      if (mode === "overlay") {
        out[i] = a[i] * (1 - blend) + b[i] * blend;
        out[i + 1] = a[i + 1] * (1 - blend) + b[i + 1] * blend;
        out[i + 2] = a[i + 2] * (1 - blend) + b[i + 2] * blend;
      } else {
        const v =
          (Math.abs(a[i] - b[i]) +
            Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2])) /
          3;
        out[i] = Math.min(255, 11 + v * 3);
        out[i + 1] = Math.min(210, 16 + v * 1.6);
        out[i + 2] = Math.min(110, 24 + v * 0.5);
      }
      out[i + 3] = 255;
    }
    rollingContext.putImageData(new ImageData(out, w, h), 0, 0);
  }
}
function acceptPair(globalImage, rollingImage, params, time) {
  rawGlobal = globalImage;
  rawRolling = rollingImage;
  const a = globalImage.data,
    b = rollingImage.data;
  let difference = 0;
  for (let i = 0; i < a.length; i += 4)
    difference +=
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
  pixelMae = difference / (params.width * params.height * 3);
  $("pixel-mae").textContent = pixelMae.toFixed(2);
  paintPair();
  kernelMs = time;
  frameCount++;
  currentFrame = {
    ...params,
    kernelMs: time,
    backend: activeBackend,
    simulationTime,
  };
}
function setMode(value) {
  mode = value;
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === value);
    b.setAttribute("aria-pressed", String(b.dataset.mode === value));
  });
  $("blend-control").hidden = value !== "overlay";
  $("rolling-title").textContent =
    value === "overlay"
      ? "Shutter overlay"
      : value === "difference"
        ? "Frame difference"
        : "Rolling shutter";
  $("rolling-type").textContent =
    value === "overlay"
      ? "두 영상 겹치기"
      : value === "difference"
        ? "RGB 차이 강조"
        : "순서대로 촬영";
  $("rolling-view-label").textContent =
    value === "overlay"
      ? "BLEND"
      : value === "difference"
        ? "ABS DIFFERENCE"
        : "ROW BY ROW";
  $("rolling-caption").textContent =
    value === "overlay"
      ? "겹쳐진 두 물체의 윤곽으로 자세 차이를 관찰합니다."
      : value === "difference"
        ? "밝을수록 RGB 차이가 큽니다. 색상으로 차이를 강조합니다."
        : "행마다 달라진 물체의 자세가 한 장에 모입니다.";
  paintPair();
}
document
  .querySelectorAll("[data-mode]")
  .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("blend").addEventListener("input", () => {
  blend = Number($("blend").value) / 100;
  $("blend-value").textContent = `${Math.round(blend * 100)}%`;
  paintPair();
});
function showMessage(text, isError = false) {
  $("experiment-message").hidden = false;
  $("experiment-message").textContent = text;
  $("experiment-message").classList.toggle("error", isError);
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save-settings").addEventListener("click", () => {
  const settings = createSettings({
    config,
    state,
    simulationTime,
    speed,
    mode,
    blend,
  });
  downloadBlob(
    new Blob([JSON.stringify(settings, null, 2) + "\n"], {
      type: "application/json",
    }),
    "shutter-lab-experiment.json",
  );
  showMessage(
    "물체와 현재 물리 상태, 촬영 조건을 저장했습니다. 불러오면 같은 순간부터 비교할 수 있습니다.",
  );
});
$("load-settings").addEventListener("click", () => $("settings-file").click());
$("settings-file").addEventListener("change", async () => {
  const file = $("settings-file").files[0];
  if (!file) return;
  try {
    if (file.size > 65536)
      throw new Error("실험 조건 파일은 64 KB 이하여야 합니다.");
    const saved = validateSettings(JSON.parse(await file.text()));
    config = {
      ...config,
      ...saved.camera,
      torque: saved.physics.torque,
      inertia: saved.physics.inertia,
      damping: saved.physics.damping,
      objectId: OBJECTS.find((o) => o.key === saved.object).id,
      omegaRpm: radiansPerSecondToRpm(saved.physics.omega),
    };
    state = { angle: saved.physics.angle, omega: saved.physics.omega };
    simulationTime = saved.simulationTime;
    speed = saved.display.speed;
    blend = saved.display.blend;
    history = [];
    lastHistoryTime = 0;
    for (const key of controls)
      $(key).value =
        key === "rpm"
          ? Math.max(0, Math.min(600, config.omegaRpm))
          : config[key];
    $("playback-speed").value = speed;
    $("blend").value = blend * 100;
    $("blend-value").textContent = `${Math.round(blend * 100)}%`;
    setMode(saved.display.mode);
    setPlaying(false);
    document.querySelectorAll("[data-preset]").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    revision++;
    syncControls();
    updateMetrics();
    drawTiming();
    showMessage(
      "실험 조건을 불러왔습니다. 같은 물리 상태에서 일시정지했습니다.",
    );
  } catch (error) {
    showMessage(`불러올 수 없습니다. ${error.message}`, true);
  } finally {
    $("settings-file").value = "";
  }
});
function selectBackend() {
  activeBackend =
    $("backend").value === "webgl" || !nativeAvailable ? "webgl" : "cuda";
  $("engine-name").textContent =
    activeBackend === "cuda" ? "CUDA RAY TRACING" : "WEBGL2 · BROWSER";
  $("gpu-name").textContent =
    activeBackend === "cuda" ? gpuName : "CUDA가 필요 없는 브라우저 렌더러";
  $("render-time-label").textContent =
    activeBackend === "cuda"
      ? "CUDA 커널 실행 시간"
      : "브라우저 프레임 그리기 시간";
  revision++;
  kernelMs = null;
}
$("backend").addEventListener("change", selectBackend);

async function renderFrame() {
  if (inflight) return;
  if (!playing && renderedRevision === revision) {
    setTimeout(renderFrame, 70);
    return;
  }
  inflight = true;
  const frameRevision = revision,
    width =
      activeBackend === "webgl"
        ? window.innerWidth < 650
          ? 224
          : 320
        : window.innerWidth < 650
          ? 448
          : 640,
    height = Math.round(width * 0.7);
  const params = {
    width,
    height,
    angle: state.angle,
    omega: state.omega,
    torque: config.torque,
    inertia: config.inertia,
    damping: config.damping,
    scanMs: config.scanMs,
    exposureMs: config.exposureMs,
    fov: config.fov,
    lens: config.lens,
    tilt: config.tilt,
    direction: config.direction,
    samples: config.samples,
    offsetX: config.offsetX,
    objectId: config.objectId,
  };
  try {
    let globalImage, rollingImage, renderMs;
    if (activeBackend === "cuda") {
      const response = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || `Render failed (${response.status})`);
      }
      const bytes = await response.arrayBuffer(),
        header = new DataView(bytes);
      if (
        header.getUint32(0, true) !== 0x53485554 ||
        header.getUint32(12, true) !== 1 ||
        bytes.byteLength !== 16 + width * height * 8
      )
        throw new Error("CUDA 프레임 데이터가 올바르지 않습니다.");
      globalImage = new ImageData(
        new Uint8ClampedArray(bytes, 16, width * height * 4),
        width,
        height,
      );
      rollingImage = new ImageData(
        new Uint8ClampedArray(
          bytes,
          16 + width * height * 4,
          width * height * 4,
        ),
        width,
        height,
      );
      renderMs = header.getFloat32(8, true);
    } else {
      if (!webglGlobal) {
        webglGlobal = new WebGLRenderer(document.createElement("canvas"));
        webglRolling = new WebGLRenderer(document.createElement("canvas"));
      }
      const start = performance.now();
      webglGlobal.render({ ...params, rolling: false });
      webglRolling.render({ ...params, rolling: true });
      if (webglReadback.width !== width || webglReadback.height !== height) {
        webglReadback.width = width;
        webglReadback.height = height;
      }
      webglReadbackContext.drawImage(webglGlobal.canvas, 0, 0);
      globalImage = webglReadbackContext.getImageData(0, 0, width, height);
      webglReadbackContext.drawImage(webglRolling.canvas, 0, 0);
      rollingImage = webglReadbackContext.getImageData(0, 0, width, height);
      renderMs = performance.now() - start;
    }
    if (frameRevision === revision) {
      for (const canvas of [globalCanvas, rollingCanvas])
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
      acceptPair(globalImage, rollingImage, params, renderMs);
      renderedRevision = frameRevision;
      $("render-size").textContent = `${width} × ${height} / VIEW`;
      const now = performance.now();
      if (lastRenderTime) {
        const instant = 1000 / (now - lastRenderTime);
        imageFps = imageFps ? imageFps * 0.8 + instant * 0.2 : instant;
      }
      lastRenderTime = now;
      $("frame-state").textContent = playing
        ? `실시간 · ${Math.round(imageFps)} fps`
        : "프레임 고정";
      $("render-error").hidden = true;
      errorCount = 0;
    }
  } catch (error) {
    errorCount++;
    $("render-error").hidden = false;
    $("render-error").textContent =
      `렌더링 연결을 확인하고 있습니다. ${error.message}`;
    $("frame-state").textContent = "연결 재시도";
    if (errorCount >= 3 && activeBackend === "cuda") {
      nativeAvailable = false;
      selectBackend();
      showMessage(
        "CUDA 연결이 끊겨 브라우저 렌더러로 전환했습니다. CUDA를 다시 쓰려면 서버를 재시작해 주세요.",
      );
    }
  } finally {
    inflight = false;
    setTimeout(renderFrame, errorCount ? 1000 : 30);
  }
}

function animate(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (playing) {
    state = advanceRotation(state, dt * speed, config);
    simulationTime += dt * speed;
  }
  if (now - lastMetricsTime > 90) {
    updateMetrics();
    lastMetricsTime = now;
  }
  requestAnimationFrame(animate);
}

$("capture").addEventListener("click", () => {
  if (!currentFrame) return;
  const w = globalCanvas.width,
    h = globalCanvas.height,
    canvas = document.createElement("canvas");
  canvas.width = w * 2 + 72;
  canvas.height = h + 160;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#10151c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f1f3f6";
  ctx.font = "600 24px system-ui";
  ctx.fillText(
    `Shutter Lab / ${OBJECTS.find((o) => o.id === currentFrame.objectId).name}`,
    24,
    40,
  );
  ctx.font = "14px system-ui";
  ctx.fillStyle = "#a4b1c2";
  ctx.fillText("GLOBAL SHUTTER", 24, 75);
  ctx.fillStyle = "#b2d1b5";
  ctx.fillText(
    mode === "overlay"
      ? "SHUTTER OVERLAY"
      : mode === "difference"
        ? "RGB DIFFERENCE"
        : "ROLLING SHUTTER",
    w + 48,
    75,
  );
  ctx.drawImage(globalCanvas, 24, 90);
  ctx.drawImage(rollingCanvas, w + 48, 90);
  ctx.font = "13px monospace";
  ctx.fillStyle = "#aab9cc";
  ctx.fillText(
    `${currentFrame.lens.toUpperCase()} | ${currentFrame.fov}° | scan ${currentFrame.scanMs} ms | exposure ${currentFrame.exposureMs} ms | ${radiansPerSecondToRpm(currentFrame.omega).toFixed(1)} rpm`,
    24,
    h + 123,
  );
  ctx.fillText(
    `${currentFrame.backend.toUpperCase()} ${currentFrame.kernelMs.toFixed(2)} ms | I=${currentFrame.inertia} | torque=${currentFrame.torque} | damping=${currentFrame.damping}`,
    24,
    h + 146,
  );
  canvas.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `shutter-lab-${Date.now()}.png`);
  });
});

setPreset("baseline");
try {
  const response = await fetch("/api/status"),
    status = await response.json();
  nativeAvailable =
    response.ok &&
    status.native &&
    String(status.backend).toLowerCase() === "cuda";
  gpuName = status.gpu || "NVIDIA GPU";
} catch {
  nativeAvailable = false;
}
if (!nativeAvailable)
  $("backend").options[0].textContent = "자동 선택 (브라우저)";
selectBackend();
requestAnimationFrame(animate);
renderFrame();
window.shutterLab = {
  getState: () => ({
    config: { ...config },
    state: { ...state },
    playing,
    simulationTime,
    frameCount,
    currentFrame,
    activeBackend,
    mode,
    blend,
    pixelMae,
  }),
  setPreset,
  setPlaying,
  renderFrame,
};
