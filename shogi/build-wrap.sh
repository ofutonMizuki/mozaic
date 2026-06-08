#!/bin/sh
# Build the native USI wrapper binary (build/shogi-usi) for GUIs that require a
# single executable (e.g. ShogiHome). Bakes this checkout's absolute paths so the
# binary works regardless of the cwd the GUI launches it from; both are still
# overridable at runtime via MZ_SHOGI_BIN / MZ_SHOGI_WEIGHTS.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CXX="${MZ_CXX:-clang++}"
"$CXX" -std=c++20 -O2 -pthread \
  -DENGINE_PATH="\"$ROOT/build/shogi\"" \
  -DWEIGHTS_PATH="\"$ROOT/shogi/weights.txt\"" \
  -o build/shogi-usi shogi/usi_wrap.cpp
echo "built build/shogi-usi  (engine=$ROOT/build/shogi, weights=$ROOT/shogi/weights.txt)"
echo "Register this path in ShogiHome:  $ROOT/build/shogi-usi"
