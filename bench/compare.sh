#!/bin/sh
# compare.sh — one-shot multi-way speed comparison on Apple Silicon:
#   native C++ (hand-written, clang -O3)  vs  mozaic CPU (parallel)  vs  mozaic GPU (Metal)
# across a compute-bound kernel (heavy), a memory-bound kernel (vadd) and a scalar integer loop.
# Plus the UMA effect (GPU-shared vs GPU-private) via bench/run.sh, and front-end compile speed.
# All mozaic kernels/launch/runtime are compiler output; native twins live in bench/native.cpp & scalar_native.cpp.
set -e
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/.." && pwd)
comp="node --disable-warning=ExperimentalWarning $root/src/main.ts"
mkdir -p "$root/build"
us() { awk -v v="$1" 'BEGIN{printf "%12.1f", v/1000.0}'; }   # ns -> us

echo "machine: $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) threads"
echo "============================================================================"

echo "[1] native C++ baselines (clang -O3, true f32)"
clang++ -std=c++20 -O3 "$here/native.cpp" -o "$root/build/native"; "$root/build/native"
echo

echo "[2] mozaic-compiled kernels — us/launch (CPU=parallel mz::launch, GPU=Metal UMA)"
echo "kernel | mozaic CPU(us) | mozaic GPU(us) | CPU/GPU"
for kf in "heavy heavy.mzc" "vadd vadd.mzc"; do
  set -- $kf; name=$1; file="$here/$2"
  c=$($comp run "$file" 2>/dev/null | head -1)
  g=$($comp run "$file" --gpu 2>/dev/null | head -1)
  awk -v n="$name" -v c="$c" -v g="$g" 'BEGIN{printf "%-6s | %14.1f | %14.1f | %6.1fx\n", n, c/1000.0, g/1000.0, c/g}'
done
echo

echo "[3] scalar integer LCG (dependent chain, 20M x 40 reps) — ms/rep, release"
clang++ -std=c++20 -O3 "$here/scalar_native.cpp" -o "$root/build/scalar_native"
$comp build "$here/scalar.mzc" --release >/dev/null 2>&1
mn=$("$root/build/scalar" | head -1); mc=$("$root/build/scalar" | tail -1)
nn=$("$root/build/scalar_native" | head -1); nc=$("$root/build/scalar_native" | tail -1)
awk -v m="$mn" -v n="$nn" 'BEGIN{printf "mozaic %.2f ms/rep  |  native C++ %.2f ms/rep  |  ratio %.2fx\n", m/1e6, n/1e6, m/n}'
[ "$mc" = "$nc" ] && echo "checksums identical ($mc) — same computation" || echo "WARN checksums differ: $mc vs $nc"
echo

echo "[4] front-end compile speed (lex+parse+check+emit only, no clang back-end)"
printf "  mozaic (TS/Node) heavy.mzc:   "; /usr/bin/time -p sh -c "$comp emit '$here/heavy.mzc' >/dev/null 2>&1" 2>&1 | awk '/^real/{print $2" s"}'
printf "  mozc  (native)  selfhost.mzc: "; /usr/bin/time -p sh -c "'$root/build/selfhost' < '$root/tests/cases/selfhost.mzc' >/dev/null 2>&1" 2>&1 | awk '/^real/{print $2" s (2000+ lines)"}'
echo "  (clang -O3 back-end of the emitted C++ is the bulk of total build time, ~0.5 s — runtime header)"
echo "(run bench/run.sh 23 25 7 128 for the UMA shared-vs-private comparison)"
