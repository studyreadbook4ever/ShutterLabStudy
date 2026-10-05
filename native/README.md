# Native CUDA renderer

Build with `make -C native` using CUDA 12 or newer with `nvcc` on PATH. The
default `CUDA_ARCH=native` targets the detected local GPU; for another target,
use `make -C native CUDA_ARCH=sm_75` or override `NVCC` and `NVCCFLAGS`.
`native/shutter-renderer --info` reports the actual CUDA device. Run
`native/shutter-renderer --self-test` for image and motion-law checks.

The persistent process accepts one newline-terminated request at a time:

```text
width height theta omega torque inertia damping scanSeconds exposureSeconds fovDegrees lens tiltDegrees direction samples offsetX [objectId]
```

Angles `theta` and `omega` use radians and radians per second. Torque uses N·m,
inertia uses kg·m², damping uses N·m·s/rad. `lens` is 0 for rectilinear pinhole
and 1 for equidistant fisheye. `direction` is +1 for top-to-bottom scan and -1
for bottom-to-top scan. FOV is horizontal. Each panel is `width × height`.

The optional sixteenth field selects a moving rigid body: 0 = rod (default),
1 = three-blade propeller, 2 = square frame, 3 = six-spoke wheel. Omitting it
preserves the original protocol. Invalid IDs terminate with an error. The
propeller uses three rounded capsule blades, the frame uses four rounded bars
and colored corners, and the wheel uses six capsule spokes and a sphere-traced
toroidal tire. Object-space colored marks make rotational symmetry observable.
All four bodies use the same motion law, exposure, tilt, offset, lens, and
scene lighting; their cast shadows are traced against the same moving body.
The backdrop is at z = −2.2 m, behind every object's permitted tilted geometry.

| ID | Geometry (metres) |
| --- | --- |
| 0 | Rod: axis endpoints ±1.60, capsule radius 0.105, overall length 3.41 |
| 1 | Three blades: axis endpoints 0.25–1.50 from pivot, radius 0.15, tip radius 1.65 |
| 2 | Square: half side 1.10, edge radius 0.10, corner radius 0.14, support radius 0.027 |
| 3 | Wheel: tire major radius 1.60, tube radius 0.10; six spokes from radius 0.16–1.56, tube radius 0.06 |

The camera is at `(0, 0, 5.8)`, looking down −Z with +Y up. Every body shares
the pivot `(offsetX, 0, 0)` and plane tilted about world Y. The hub radius is
0.215 and depth 0.25. The fixed grid spacing is 0.5, major grid spacing 2.0,
and the dial radius is 1.70 with ticks every 30 degrees.

Every response has exactly a 16-byte little-endian header:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | uint32 | Magic `0x53485554` |
| 4 | uint32 | Payload byte count, `width × height × 8` |
| 8 | float32 | CUDA event kernel time in milliseconds |
| 12 | uint32 | Backend ID, 1 for CUDA |

The payload is the row-major RGBA global-shutter panel, then the row-major RGBA
rolling-shutter panel. Output is flushed after each response. Diagnostics go
only to stderr. Invalid numeric fields and invalid dimensions terminate the
process with a nonzero exit code. Finite control values are clamped to bounded
simulation ranges; dimensions are 1–2048 per side, samples 1–16.
Angular velocity allows ±1,000,000 rad/s so acceleration during a running
simulation does not silently saturate at the initial-speed slider range.

The object's motion solves `I ω′ = τ − b ω` analytically, with `theta` and `omega`
defined at the midpoint of readout and exposure. Temporal quadrature samples
each pixel's exposure uniformly; each temporal sample uses four spatial
subpixel rays. Pixel colors are averaged in linear light before sRGB encoding.
The rolling sample time is:

```text
direction × scanSeconds × ((row + 0.5) / height − 0.5)
  + exposureSeconds × ((sample + 0.5) / samples − 0.5)
```

Pinhole rays use `tan(horizontalFOV / 2)`. Equidistant fisheye rays use angular
distance `r × horizontalFOV / 2`, with the same principal point and horizontal
FOV. The fixed background grid therefore exhibits optical distortion, whereas
only moving geometry exhibits rolling-shutter time distortion. The scene is
an analytic capsule, cylinder, and torus ray tracer; it does not rasterize or warp a
previously rendered image. Allocations and CUDA events are reused per process.
