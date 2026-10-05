import { rotationAtTime, TAU } from "./physics.mjs";

const VERTEX = `#version 300 es
void main() {
  vec2 position = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 u_size;
uniform float u_angle, u_omega, u_torque, u_inertia, u_damping;
uniform float u_scan, u_exposure, u_fov, u_tilt, u_offset;
uniform int u_lens, u_direction, u_samples, u_object, u_rolling;
uniform int u_phaseTable;
uniform sampler2D u_phases;
out vec4 outColor;
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const float EPS = 0.0001;

struct Hit { float t; vec3 normal; float axial; int material; int part; };

float angleAt(float time, int sampleIndex, int row) {
  if (u_phaseTable == 1) return texelFetch(u_phases, ivec2(sampleIndex, row), 0).r;
  float acceleration = u_torque / u_inertia;
  float phase;
  if (u_damping == 0.0) {
    phase = u_angle + u_omega * time + 0.5 * acceleration * time * time;
  } else {
    float decay = u_damping / u_inertia;
    acceleration -= decay * u_omega;
    float z = decay * time;
    // Stable second integral of exponential damping, including negative time.
    float secondIntegral;
    if (abs(z) < 0.02) {
      secondIntegral = time * time * (0.5 - z / 6.0 + z * z / 24.0
        - z * z * z / 120.0 + z * z * z * z / 720.0);
    } else {
      secondIntegral = (exp(-z) - 1.0 + z) / (decay * decay);
    }
    phase = u_angle + u_omega * time + acceleration * secondIntegral;
  }
  return mod(phase + PI, TAU) - PI;
}

vec3 cameraRay(vec2 pixel) {
  vec2 sensor = vec2(2.0 * pixel.x / u_size.x - 1.0,
    (1.0 - 2.0 * pixel.y / u_size.y) * u_size.y / u_size.x);
  float halfFov = u_fov * PI / 360.0;
  if (u_lens == 0) return normalize(vec3(sensor * tan(halfFov), -1.0));
  float radius = length(sensor);
  if (radius < 0.0000001) return vec3(0.0, 0.0, -1.0);
  float theta = radius * halfFov;
  return vec3(sensor * sin(theta) / radius, -cos(theta));
}

vec3 toLocal(vec3 value, float angle) {
  float ct = cos(u_tilt), st = sin(u_tilt);
  vec3 tilted = vec3(ct * value.x - st * value.z, value.y,
    st * value.x + ct * value.z);
  float c = cos(angle), s = sin(angle);
  return vec3(c * tilted.x + s * tilted.y, -s * tilted.x + c * tilted.y, tilted.z);
}

vec3 toWorld(vec3 value, float angle) {
  float c = cos(angle), s = sin(angle);
  vec3 rotated = vec3(c * value.x - s * value.y, s * value.x + c * value.y, value.z);
  float ct = cos(u_tilt), st = sin(u_tilt);
  return vec3(ct * rotated.x + st * rotated.z, rotated.y,
    -st * rotated.x + ct * rotated.z);
}

bool sphere(vec3 origin, vec3 ray, vec3 center, float radius, inout Hit hit) {
  vec3 oc = origin - center;
  float b = dot(oc, ray), q = dot(oc, oc) - radius * radius;
  float discriminant = b * b - q;
  if (discriminant < 0.0) return false;
  float t = -b - sqrt(discriminant);
  if (t < EPS) t = -b + sqrt(discriminant);
  if (t < EPS || t >= hit.t) return false;
  hit.t = t;
  hit.normal = normalize(origin + ray * t - center);
  return true;
}

bool capsule(vec3 origin, vec3 ray, vec3 center, vec3 axis,
  float halfLength, float radius, inout Hit hit) {
  vec3 oc = origin - center;
  float da = dot(ray, axis), oa = dot(oc, axis);
  vec3 pd = ray - axis * da, po = oc - axis * oa;
  float a = dot(pd, pd), b = dot(pd, po), q = dot(po, po) - radius * radius;
  float discriminant = b * b - a * q;
  bool found = false;
  if (a > 0.00000001 && discriminant >= 0.0) {
    float t = (-b - sqrt(discriminant)) / a;
    if (t < EPS) t = (-b + sqrt(discriminant)) / a;
    float axial = oa + t * da;
    if (t > EPS && t < hit.t && abs(axial) <= halfLength) {
      hit.t = t; hit.normal = normalize(po + pd * t); hit.axial = axial;
      found = true;
    }
  }
  if (sphere(origin, ray, center + axis * halfLength, radius, hit)) {
    hit.axial = dot(origin + ray * hit.t - center, axis); found = true;
  }
  if (sphere(origin, ray, center - axis * halfLength, radius, hit)) {
    hit.axial = dot(origin + ray * hit.t - center, axis); found = true;
  }
  return found;
}

bool cylinder(vec3 origin, vec3 ray, vec3 center, float radius,
  float halfHeight, inout Hit hit) {
  vec3 oc = origin - center;
  float a = dot(ray.xy, ray.xy), b = dot(ray.xy, oc.xy);
  float q = dot(oc.xy, oc.xy) - radius * radius;
  float discriminant = b * b - a * q;
  bool found = false;
  if (a > 0.00000001 && discriminant >= 0.0) {
    for (int i = 0; i < 2; i++) {
      float signRoot = i == 0 ? -1.0 : 1.0;
      float t = (-b + signRoot * sqrt(discriminant)) / a;
      float z = oc.z + ray.z * t;
      if (t > EPS && t < hit.t && abs(z) <= halfHeight) {
        hit.t = t; hit.normal = vec3(normalize(oc.xy + ray.xy * t), 0.0);
        hit.axial = z; found = true;
      }
    }
  }
  if (abs(ray.z) > 0.0000001) {
    for (int i = 0; i < 2; i++) {
      float side = i == 0 ? -1.0 : 1.0;
      float t = (side * halfHeight - oc.z) / ray.z;
      vec2 radial = oc.xy + ray.xy * t;
      if (t > EPS && t < hit.t && dot(radial, radial) <= radius * radius) {
        hit.t = t; hit.normal = vec3(0.0, 0.0, side); hit.axial = side * halfHeight;
        found = true;
      }
    }
  }
  return found;
}

// A finite-thickness annular rim: inner/outer cylinder walls and both end faces.
// This has the same 1.60 m mean radius as the native wheel, with a rectangular
// cross-section instead of the native torus's circular cross-section.
bool annulus(vec3 origin, vec3 ray, inout Hit hit) {
  const float innerRadius = 1.50, outerRadius = 1.70, halfHeight = 0.10;
  bool found = false;
  float a = dot(ray.xy, ray.xy), b = dot(ray.xy, origin.xy);
  if (a > 0.00000001) {
    for (int wall = 0; wall < 2; wall++) {
      float radius = wall == 0 ? outerRadius : innerRadius;
      float q = dot(origin.xy, origin.xy) - radius * radius;
      float discriminant = b * b - a * q;
      if (discriminant >= 0.0) {
        for (int i = 0; i < 2; i++) {
          float t = (-b + (i == 0 ? -1.0 : 1.0) * sqrt(discriminant)) / a;
          float z = origin.z + ray.z * t;
          if (t > EPS && t < hit.t && abs(z) <= halfHeight) {
            hit.t = t;
            hit.normal = vec3(normalize(origin.xy + ray.xy * t) * (wall == 0 ? 1.0 : -1.0), 0.0);
            found = true;
          }
        }
      }
    }
  }
  if (abs(ray.z) > 0.0000001) {
    for (int side = 0; side < 2; side++) {
      float signSide = side == 0 ? -1.0 : 1.0;
      float t = (signSide * halfHeight - origin.z) / ray.z;
      float radius = length(origin.xy + ray.xy * t);
      if (t > EPS && t < hit.t && radius >= innerRadius && radius <= outerRadius) {
        hit.t = t; hit.normal = vec3(0.0, 0.0, signSide); found = true;
      }
    }
  }
  return found;
}

void bar(vec3 origin, vec3 ray, vec3 center, vec3 axis, float halfLength,
  float radius, int part, inout Hit hit) {
  if (capsule(origin, ray, center, axis, halfLength, radius, hit)) {
    hit.material = 1; hit.part = part;
  }
}

Hit traceObject(vec3 origin, vec3 ray) {
  Hit hit = Hit(1e20, vec3(0.0), 0.0, 0, 0);
  if (u_object == 0) {
    bar(origin, ray, vec3(0.0), vec3(1.0, 0.0, 0.0), 1.60, 0.105, 0, hit);
  } else if (u_object == 1) {
    for (int i = 0; i < 3; i++) {
      float angle = float(i) * TAU / 3.0;
      vec3 axis = vec3(cos(angle), sin(angle), 0.0);
      bar(origin, ray, axis * 0.875, axis, 0.625, 0.15, i + 1, hit);
    }
  } else if (u_object == 2) {
    for (int i = 0; i < 4; i++) {
      float angle = float(i) * PI / 2.0;
      vec3 radial = vec3(cos(angle), sin(angle), 0.0);
      vec3 axis = vec3(-sin(angle), cos(angle), 0.0);
      bar(origin, ray, radial * 1.1, axis, 1.1, 0.10, i + 1, hit);
      vec3 cornerAxis = vec3(cos(angle + PI / 4.0), sin(angle + PI / 4.0), 0.0);
      bar(origin, ray, cornerAxis * 0.55, cornerAxis, 0.55, 0.027, 5, hit);
      if (sphere(origin, ray, cornerAxis * (1.1 * sqrt(2.0)), 0.14, hit)) {
        hit.material = 1; hit.part = i + 1; hit.axial = 0.0;
      }
    }
  } else {
    if (annulus(origin, ray, hit)) {
      hit.material = 1; hit.part = 6; hit.axial = 0.0;
    }
    for (int i = 0; i < 6; i++) {
      float angle = float(i) * PI / 3.0;
      vec3 axis = vec3(cos(angle), sin(angle), 0.0);
      bar(origin, ray, axis * 0.86, axis, 0.70, 0.060, i == 0 ? 7 : i % 2 + 1, hit);
    }
  }
  if (cylinder(origin, ray, vec3(0.0, 0.0, 0.075), 0.215, 0.125, hit)) hit.material = 2;
  if (cylinder(origin, ray, vec3(0.0, 0.0, 0.208), 0.070, 0.018, hit)) hit.material = 3;
  return hit;
}

float periodicLine(float value, float period, float width) {
  float distance = abs(value - period * floor(value / period + 0.5));
  return 1.0 - smoothstep(width, width * 1.6, distance);
}

vec3 scene(vec3 ray, float angle) {
  vec3 origin = vec3(0.0, 0.0, 5.8), center = vec3(u_offset, 0.0, 0.0);
  vec3 localOrigin = toLocal(origin - center, angle), localRay = toLocal(ray, angle);
  Hit hit = traceObject(localOrigin, localRay);
  if (ray.z >= -0.00001) {
    return mix(vec3(0.008, 0.015, 0.028), vec3(0.024, 0.042, 0.064),
      clamp(0.5 + ray.y * 0.3, 0.0, 1.0));
  }
  float backgroundT = (-2.20 - origin.z) / ray.z;
  if (hit.t < backgroundT) {
    vec3 point = origin + ray * hit.t;
    vec3 localPoint = localOrigin + localRay * hit.t;
    vec3 normal = toWorld(hit.normal, angle);
    vec3 light = normalize(vec3(-3.4, 4.4, 5.5) - point), view = -ray;
    vec3 halfVector = normalize(light + view);
    float diffuse = max(dot(normal, light), 0.0);
    float rim = pow(1.0 - clamp(dot(normal, view), 0.0, 1.0), 3.0);
    vec3 base;
    float specular, emission = 0.0;
    if (hit.material == 1) {
      vec3 orange = vec3(0.95, 0.245, 0.026), cream = vec3(0.67, 0.76, 0.82);
      base = hit.part == 0 ? (hit.axial >= 0.0 ? orange : cream)
        : hit.part == 1 ? orange : hit.part == 2 ? cream
        : hit.part == 3 ? vec3(0.68, 0.15, 0.025)
        : hit.part == 4 ? cream : hit.part == 5 ? vec3(0.045, 0.078, 0.095)
        : hit.part == 7 ? vec3(0.97, 0.66, 0.13) : vec3(0.30, 0.44, 0.50);
      if (u_object == 2 && hit.part == 3) base = vec3(0.07, 0.53, 0.54);
      float tick = periodicLine(hit.axial, 0.40, 0.011);
      if (abs(hit.axial) > 0.26 && abs(hit.axial) < 1.48 && hit.part != 6)
        base = mix(base, vec3(0.028, 0.047, 0.064), tick * 0.65);
      if (hit.part == 6 && localPoint.x > 1.48 && abs(localPoint.y) < 0.22)
        base = vec3(0.97, 0.66, 0.13);
      specular = pow(max(dot(normal, halfVector), 0.0), 58.0) * 0.42;
      emission = hit.part == 1 || (hit.part == 0 && hit.axial >= 0.0) ? 0.065 : 0.01;
    } else if (hit.material == 2) {
      float radius = length(localPoint.xy);
      base = radius > 0.175 ? vec3(0.24, 0.30, 0.34) : vec3(0.080, 0.12, 0.15);
      if (radius > 0.145 && radius < 0.160) base = vec3(0.12, 0.53, 0.54);
      specular = pow(max(dot(normal, halfVector), 0.0), 90.0) * 0.75;
    } else {
      base = vec3(0.65, 0.74, 0.77);
      specular = pow(max(dot(normal, halfVector), 0.0), 120.0) * 0.8;
    }
    return base * (0.29 + 0.74 * diffuse + emission)
      + vec3(0.72, 0.82, 0.90) * specular + vec3(0.09, 0.16, 0.20) * rim;
  }
  vec3 point = origin + ray * backgroundT;
  float radius = length(point.xy);
  float illumination = 0.83 + 0.22 * exp(-0.07 * radius * radius);
  vec3 base = vec3(0.014, 0.029, 0.047);
  float grid = max(periodicLine(point.x, 0.5, 0.008), periodicLine(point.y, 0.5, 0.008));
  float major = max(periodicLine(point.x, 2.0, 0.0096), periodicLine(point.y, 2.0, 0.0096));
  base = mix(base, vec3(0.040, 0.064, 0.080), grid * 0.72);
  base = mix(base, vec3(0.065, 0.093, 0.106), major * 0.64);
  float axes = max(1.0 - smoothstep(0.009, 0.016, abs(point.x)),
    1.0 - smoothstep(0.009, 0.016, abs(point.y)));
  base = mix(base, vec3(0.077, 0.125, 0.145), axes * 0.85);
  float ring = 1.0 - smoothstep(0.008, 0.019, abs(radius - 1.70));
  base = mix(base, vec3(0.13, 0.22, 0.25), ring * 0.75);
  float tick = periodicLine(atan(point.y, point.x), PI / 6.0, 0.005);
  if (radius > 1.60 && radius < 1.79) base = mix(base, vec3(0.17, 0.29, 0.32), tick);
  return base * illumination;
}

vec3 encode(vec3 linear) {
  vec3 value = clamp(linear, 0.0, 1.0);
  return mix(12.92 * value, 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), value));
}

void main() {
  // gl_FragCoord starts at bottom left; camera rows and readout start at top.
  vec2 pixel = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  int row = int(floor(pixel.y));
  float rowTime = u_rolling == 1
    ? float(u_direction) * u_scan * (pixel.y / u_size.y - 0.5) : 0.0;
  vec3 accumulated = vec3(0.0);
  for (int sampleIndex = 0; sampleIndex < 16; sampleIndex++) {
    if (sampleIndex >= u_samples) break;
    float time = rowTime + u_exposure * ((float(sampleIndex) + 0.5) / float(u_samples) - 0.5);
    float angle = angleAt(time, sampleIndex, row);
    for (int spatial = 0; spatial < 4; spatial++) {
      vec2 offset = spatial == 0 ? vec2(0.125, 0.375) : spatial == 1 ? vec2(0.625, 0.125)
        : spatial == 2 ? vec2(0.375, 0.875) : vec2(0.875, 0.625);
      accumulated += scene(cameraRay(floor(pixel) + offset), angle);
    }
  }
  outColor = vec4(encode(accumulated / float(4 * u_samples)), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL2 shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compilation failed: ${reason}`);
  }
  return shader;
}

function validate(params, maxSize) {
  const p = { objectId: 0, rolling: false, ...params };
  for (const name of [
    "width",
    "height",
    "angle",
    "omega",
    "torque",
    "inertia",
    "damping",
    "scanMs",
    "exposureMs",
    "fov",
    "tilt",
    "direction",
    "samples",
    "offsetX",
    "objectId",
  ]) {
    if (!Number.isFinite(p[name]))
      throw new RangeError(`WebGL2 ${name} must be finite`);
  }
  for (const name of ["width", "height"]) {
    if (!Number.isInteger(p[name]) || p[name] < 1 || p[name] > maxSize)
      throw new RangeError(
        `WebGL2 ${name} must be an integer from 1 to ${maxSize}`,
      );
  }
  if (p.inertia <= 0 || p.damping < 0)
    throw new RangeError(
      "WebGL2 inertia must be positive and damping nonnegative",
    );
  if (p.scanMs < 0 || p.exposureMs < 0)
    throw new RangeError("WebGL2 timing intervals must be nonnegative");
  if (p.fov <= 0 || p.fov >= 180)
    throw new RangeError(
      "WebGL2 horizontal FOV must be between 0 and 180 degrees",
    );
  if (!["pinhole", "fisheye"].includes(p.lens))
    throw new RangeError("WebGL2 lens must be pinhole or fisheye");
  if (p.direction !== 1 && p.direction !== -1)
    throw new RangeError("WebGL2 direction must be +1 or -1");
  if (!Number.isInteger(p.samples) || p.samples < 1 || p.samples > 16)
    throw new RangeError(
      "WebGL2 exposure samples must be an integer from 1 to 16",
    );
  if (!Number.isInteger(p.objectId) || p.objectId < 0 || p.objectId > 3)
    throw new RangeError("WebGL2 objectId must be an integer from 0 to 3");
  if (typeof p.rolling !== "boolean")
    throw new RangeError("WebGL2 rolling must be a boolean");
  return p;
}

/** Standalone browser ray tracer. renderMs includes draw submission and finish,
 * not CUDA event timing. The supplied canvas can be copied to a visible 2D
 * canvas immediately after render() with drawImage(renderer.canvas, 0, 0).
 */
export class WebGLRenderer {
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== "function")
      throw new TypeError("WebGLRenderer requires a canvas");
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl)
      throw new Error(
        "WebGL2를 사용할 수 없습니다. 브라우저의 하드웨어 가속 설정을 확인해 주세요.",
      );
    this.gl = gl;
    this.disposed = false;
    this.maxSize = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    );
    let vertex, fragment;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
      fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      this.program = gl.createProgram();
      if (!this.program) throw new Error("WebGL2 program allocation failed");
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new Error(
          `WebGL2 shader linking failed: ${gl.getProgramInfoLog(this.program)}`,
        );
      this.vao = gl.createVertexArray();
      this.phaseTexture = gl.createTexture();
      if (!this.vao || !this.phaseTexture)
        throw new Error("WebGL2 rendering resource allocation failed");
      this.uniforms = Object.fromEntries(
        [
          "size",
          "angle",
          "omega",
          "torque",
          "inertia",
          "damping",
          "scan",
          "exposure",
          "fov",
          "tilt",
          "offset",
          "lens",
          "direction",
          "samples",
          "object",
          "rolling",
          "phaseTable",
          "phases",
        ].map((name) => [
          name,
          gl.getUniformLocation(this.program, `u_${name}`),
        ]),
      );
      gl.bindTexture(gl.TEXTURE_2D, this.phaseTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        1,
        1,
        0,
        gl.RED,
        gl.FLOAT,
        new Float32Array(1),
      );
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }

  render(params) {
    if (this.disposed) throw new Error("WebGLRenderer has been disposed");
    const gl = this.gl;
    if (gl.isContextLost())
      throw new Error(
        "WebGL2 graphics context was lost; reload to restore rendering",
      );
    const p = validate(params, this.maxSize);
    const started = performance.now();
    if (this.canvas.width !== p.width) this.canvas.width = p.width;
    if (this.canvas.height !== p.height) this.canvas.height = p.height;
    gl.viewport(0, 0, p.width, p.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const u = this.uniforms;
    gl.uniform2f(u.size, p.width, p.height);
    gl.uniform1f(u.angle, p.angle % TAU);
    for (const field of ["omega", "torque", "inertia", "damping", "fov"])
      gl.uniform1f(u[field], p[field]);
    gl.uniform1f(u.scan, p.scanMs / 1000);
    gl.uniform1f(u.exposure, p.exposureMs / 1000);
    gl.uniform1f(u.tilt, (p.tilt * Math.PI) / 180);
    gl.uniform1f(u.offset, p.offsetX);
    gl.uniform1i(u.lens, p.lens === "fisheye" ? 1 : 0);
    gl.uniform1i(u.direction, p.direction);
    gl.uniform1i(u.samples, p.samples);
    gl.uniform1i(u.object, p.objectId);
    gl.uniform1i(u.rolling, p.rolling ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.phaseTexture);
    gl.uniform1i(u.phases, 0);

    // GLSL ES uses float32. At extreme backwards damping or angular speeds,
    // evaluate only the phase table in JS float64; geometry remains on GPU.
    // This preserves the same physical trajectory without clipping controls.
    const halfWindow = ((p.rolling ? p.scanMs : 0) + p.exposureMs) / 2000;
    const decay = p.damping / p.inertia;
    const midpointAngle = p.angle % TAU;
    const before = rotationAtTime(
      midpointAngle,
      p.omega,
      -halfWindow,
      p.torque,
      p.inertia,
      p.damping,
    ).angle;
    const after = rotationAtTime(
      midpointAngle,
      p.omega,
      halfWindow,
      p.torque,
      p.inertia,
      p.damping,
    ).angle;
    const phaseMagnitude = Math.max(
      Math.abs(before - midpointAngle),
      Math.abs(after - midpointAngle),
    );
    const useTable = decay * halfWindow > 8 || phaseMagnitude > 1000;
    gl.uniform1i(u.phaseTable, useTable ? 1 : 0);
    if (useTable) {
      const phases = new Float32Array(p.height * p.samples);
      for (let row = 0; row < p.height; row++) {
        const rowTime = p.rolling
          ? (p.direction * ((row + 0.5) / p.height - 0.5) * p.scanMs) / 1000
          : 0;
        for (let sample = 0; sample < p.samples; sample++) {
          const time =
            rowTime +
            (((sample + 0.5) / p.samples - 0.5) * p.exposureMs) / 1000;
          const phase = rotationAtTime(
            p.angle % TAU,
            p.omega,
            time,
            p.torque,
            p.inertia,
            p.damping,
          ).angle;
          if (!Number.isFinite(phase))
            throw new RangeError(
              "WebGL2 trajectory exceeds finite numerical range",
            );
          phases[row * p.samples + sample] = phase % TAU;
        }
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.R32F,
        p.samples,
        p.height,
        0,
        gl.RED,
        gl.FLOAT,
        phases,
      );
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    const error = gl.getError();
    if (error !== gl.NO_ERROR)
      throw new Error(
        `WebGL2 rendering failed (GL error 0x${error.toString(16)})`,
      );
    return { renderMs: performance.now() - started, backend: "WebGL2" };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    if (!gl) return;
    if (this.phaseTexture) gl.deleteTexture(this.phaseTexture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
  }
}
