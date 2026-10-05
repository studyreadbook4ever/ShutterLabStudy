#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_dir"

install_dev=0
install_browser=0
build_cuda=0

usage() {
  cat <<'HELP'
Usage: sh scripts/setup.sh [--dev] [--browser] [--cuda]

Default: check Node.js 22+ and print the local app command.
  --dev      Install locked development dependencies with npm ci.
  --browser  Install Playwright Chromium; implies --dev.
  --cuda     Build the optional native renderer with npm run build:cuda.
  --help     Show this help.

CUDA compiler settings may be supplied as NVCC, CUDA_ARCH, and NVCCFLAGS.
HELP
}

for option in "$@"; do
  case "$option" in
    --dev) install_dev=1 ;;
    --browser) install_dev=1; install_browser=1 ;;
    --cuda) build_cuda=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$option" >&2; usage >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22 or later is required. Install Node.js and rerun this script.\n' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or later is required; found " + process.version); process.exit(1); }'
if ! command -v npm >/dev/null 2>&1; then
  printf 'npm was not found. Install a Node.js distribution that includes npm.\n' >&2
  exit 1
fi
printf 'Node.js %s is ready.\n' "$(node --version)"

if [ "$install_dev" -eq 1 ]; then
  npm ci
fi
if [ "$install_browser" -eq 1 ]; then
  npx --no-install playwright install chromium
fi
if [ "$build_cuda" -eq 1 ]; then
  if ! command -v make >/dev/null 2>&1; then
    printf 'make is required for the CUDA build.\n' >&2
    exit 1
  fi
  npm run build:cuda
fi

printf '\nStart Shutter Lab with: npm start\nOpen: http://127.0.0.1:4317\n'
if [ "$build_cuda" -eq 0 ]; then
  printf 'CUDA is optional; WebGL2 renders in the browser when native CUDA is unavailable.\n'
fi
