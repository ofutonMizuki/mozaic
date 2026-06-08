#!/usr/bin/env bash
# prove.sh — end-to-end correctness proof for the mozaic language.
#
# The plain golden runner (node tests/run.ts) only ever builds the CPU path. This script
# adds the two things that runner cannot prove on its own:
#   2) the GPU/Metal backend actually runs and matches the CPU golden output, and
#   3) the concurrency primitives are deterministic under optimization (no data races).
#
# Phase 1 — CPU golden suite (positive .out, negative .err, .emit codegen assertions).
# Phase 2 — GPU: rebuild every kernel-launching case with --gpu and require byte-identical
#           output to its CPU golden .out (Apple Silicon + Metal only; SKIPped elsewhere).
# Phase 3 — Async: rebuild every concurrency case with --release and run it $STRESS times,
#           requiring the golden value on every single run.
#
# Usage:  tests/prove.sh [STRESS]     (STRESS = async repetitions, default 100)
set -u
cd "$(dirname "$0")/.."
NODE="node --disable-warning=ExperimentalWarning"
MAIN=src/main.ts
STRESS="${1:-100}"
rc=0

# Cases that launch a kernel and have a .out (CPU≡GPU expected). Negative kernel cases
# (atomic_in_kernel, kernel_array_param, kernel_buf_alias) are covered by Phase 1.
GPU_CASES="addk addk_async matadd group_reduce device_select grid3_basic bit_kernel"
# Cases that exercise threads/atomics/channels/mutex and must be deterministic.
ASYNC_CASES="spawn_join task_result atomic_counter atomic_seqcst atomic_struct atomic_buffer mutex_counter channel_mpsc arc_shared"

echo "=================================================================="
echo " mozaic proof harness"
echo "=================================================================="

echo; echo "### Phase 1: CPU golden suite"
if $NODE tests/run.ts; then echo "[Phase 1] OK"; else echo "[Phase 1] FAILED"; rc=1; fi

echo; echo "### Phase 2: GPU/Metal == CPU golden"
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  for t in $GPU_CASES; do
    src="tests/cases/$t.mzc"; out="tests/cases/$t.out"
    [ -f "$src" ] && [ -f "$out" ] || { echo "SKIP $t (missing src/out)"; continue; }
    if ! $NODE $MAIN build "$src" --gpu >"/tmp/prove_gpu_$t.log" 2>&1; then
      echo "FAIL $t (gpu build): $(tail -1 /tmp/prove_gpu_$t.log)"; rc=1; continue
    fi
    inf="tests/cases/$t.in"
    if [ -f "$inf" ]; then got=$("./build/$t" <"$inf" 2>&1); else got=$("./build/$t" 2>&1); fi
    if [ "$got" = "$(cat "$out")" ]; then echo "PASS $t (GPU == CPU golden)"; else
      echo "FAIL $t (GPU diverged): got [$(echo "$got"|tr '\n' ' ')]"; rc=1; fi
  done
else
  echo "SKIP Phase 2 (not Apple Silicon / Metal)"
fi

echo; echo "### Phase 3: async determinism (--release, ${STRESS}x each)"
for t in $ASYNC_CASES; do
  src="tests/cases/$t.mzc"; out="tests/cases/$t.out"
  [ -f "$src" ] && [ -f "$out" ] || { echo "SKIP $t"; continue; }
  if ! $NODE $MAIN build "$src" --release >"/tmp/prove_rel_$t.log" 2>&1; then
    echo "FAIL $t (build): $(tail -1 /tmp/prove_rel_$t.log)"; rc=1; continue
  fi
  want="$(cat "$out")"; bad=0; firstbad=""
  for _ in $(seq 1 "$STRESS"); do
    got=$("./build/$t" 2>&1)
    [ "$got" = "$want" ] || { bad=$((bad+1)); [ -z "$firstbad" ] && firstbad="$(echo "$got"|tr '\n' ' ')"; }
  done
  if [ "$bad" -eq 0 ]; then echo "PASS $t ($STRESS/$STRESS stable: $(echo "$want"|tr '\n' ' '))"; else
    echo "FAIL $t ($bad/$STRESS diverged; first: $firstbad)"; rc=1; fi
done

echo; echo "### Phase 4: integer-overflow trap (debug safety) — reference AND mozc must trap"
# The language guarantees checked '+' '-' '*' '/' '%' trap on overflow in debug builds (and wrap under
# --release). Prove BOTH compilers honour it: a program that overflows i32 with '+' must abort in debug.
$NODE src/main.ts build tests/cases/selfhost.mzc >/dev/null 2>&1
TRAP=/tmp/prove_trap.mzc
printf 'function main() {\n  let a: i32 = 2000000000;\n  stdout.println(a + a);\n}\n' > "$TRAP"
trap_check() { # $1=label  $2=cpp-file  ; build debug + release, require abort-with-message in debug, wrap in release
  clang++ -std=c++20 -O0 -I runtime -x c++ "$2" -o /tmp/prove_trap.bin 2>/dev/null || { echo "FAIL trap/$1 (debug cc)"; rc=1; return; }
  d=$(/tmp/prove_trap.bin 2>&1); dr=$?
  clang++ -std=c++20 -O2 -DMZ_RELEASE -I runtime -x c++ "$2" -o /tmp/prove_trapr.bin 2>/dev/null || { echo "FAIL trap/$1 (release cc)"; rc=1; return; }
  r=$(/tmp/prove_trapr.bin 2>&1)
  if [ "$dr" -ne 0 ] && printf '%s' "$d" | grep -q "integer overflow"; then
    if [ "$r" = "-294967296" ]; then echo "PASS trap/$1 (debug traps, release wraps to $r)"; else echo "FAIL trap/$1 (release not wrapping: [$r])"; rc=1; fi
  else echo "FAIL trap/$1 (debug did not trap: rc=$dr [$d])"; rc=1; fi
}
$NODE src/main.ts emit "$TRAP" >/tmp/prove_trap_ref.cpp 2>/dev/null && trap_check ref /tmp/prove_trap_ref.cpp || { echo "FAIL trap/ref (emit)"; rc=1; }
./build/selfhost < "$TRAP" >/tmp/prove_trap_mozc.cpp 2>/dev/null && trap_check mozc /tmp/prove_trap_mozc.cpp || { echo "FAIL trap/mozc (emit)"; rc=1; }

echo; echo "### Phase 5: faithfulness (mozc ≡ reference, debug & release, on every golden)"
if tests/faithful.sh; then echo "[Phase 5] OK"; else echo "[Phase 5] FAILED"; rc=1; fi

echo; echo "=================================================================="
[ "$rc" -eq 0 ] && echo " ALL PROOFS PASSED" || echo " SOME PROOFS FAILED"
echo "=================================================================="
exit $rc
