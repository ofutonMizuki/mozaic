#!/bin/sh
# Build and run the GPU/CPU/UMA benchmark. Args are forwarded to the binary:
#   bench/run.sh [log2N_min] [log2N_max] [reps] [iters]
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out="$root/build/bench"
mkdir -p "$root/build"
"${MZ_CXX:-clang++}" -std=c++20 -O2 -x objective-c++ -fobjc-arc \
  -framework Metal -framework Foundation \
  "$here/bench.mm" -o "$out"
exec "$out" "$@"
