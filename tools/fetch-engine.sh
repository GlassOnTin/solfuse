#!/usr/bin/env bash
# Re-fetch and verify the vendored engine. The WASM artifact is pinned by hash so
# anyone can confirm vendor/ matches upstream without trusting this repo's copy.
set -euo pipefail
cd "$(dirname "$0")/.."

OPENCV_VER=5.0.0-release.1   # first @techstark build here that ships the photo module
EXIFR_VER=7.1.3

fetch() {
  local url=$1 dest=$2 want=$3
  echo "fetching $dest"
  curl -fsSL -o "$dest" "$url"
  local got
  got=$(sha256sum "$dest" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "CHECKSUM MISMATCH for $dest" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    exit 1
  fi
  echo "  ok  $got"
}

fetch "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VER}/dist/opencv.js" \
      vendor/opencv.js \
      b873c8211421da7b9bf41ae157a923f05a46a0b8d3e5904c44c6f3ad6d39a1bd

fetch "https://cdn.jsdelivr.net/npm/exifr@${EXIFR_VER}/dist/lite.umd.js" \
      vendor/exifr.js \
      530dbaef11cd9d4d65f108abc159b113580eb3dbd7bc69cd1364e25dd40413f9
