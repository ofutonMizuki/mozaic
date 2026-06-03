#!/usr/bin/env bash
# faithful.sh — proves the self-hosted compiler (mozc) is BEHAVIOURALLY FAITHFUL to the reference.
# For every positive golden, compile it with BOTH the reference (src/*.ts) and mozc (selfhost.mzc),
# in BOTH debug (-O0, overflow traps) and release (-O2 -DMZ_RELEASE, overflow wraps), and require all
# four binaries to produce the golden .out. This is what the plain coverage script cannot show: that
# mozc matches the reference not just on output but on debug-vs-release semantics too.
set -u
cd "$(dirname "$0")/.."
NODE="node --disable-warning=ExperimentalWarning"
ROOT="$(pwd)"; RT="$ROOT/runtime"; MOZC="$ROOT/build/selfhost"
$NODE src/main.ts build tests/cases/selfhost.mzc >/dev/null 2>&1 || { echo "FAIL: could not build mozc"; exit 1; }
cd tests/cases
ok=0; fail=0; faillist=""
SKIP="wide128_lit"   # reference-only (mozc subset builds 128-bit via arithmetic; see wide128)
runbin() { if [ -f "$2.in" ]; then "$1" <"$2.in" 2>&1; else "$1" 2>&1; fi; }
for mzc in *.mzc; do
  base="${mzc%.mzc}"; [ -f "$base.out" ] || continue
  case " $SKIP " in *" $base "*) continue;; esac
  $NODE "$ROOT/src/main.ts" emit "$mzc"          >/tmp/f_rd.cpp 2>/dev/null || { faillist="$faillist $base(ref-emit)"; fail=$((fail+1)); continue; }
  $NODE "$ROOT/src/main.ts" emit "$mzc" --release >/tmp/f_rr.cpp 2>/dev/null
  "$MOZC" <"$mzc" >/tmp/f_m.cpp 2>/dev/null || { faillist="$faillist $base(mozc-emit)"; fail=$((fail+1)); continue; }
  bad=""
  clang++ -std=c++20 -O0              -I "$RT" -x c++ /tmp/f_rd.cpp -o /tmp/f_rd.bin 2>/dev/null && [ "$(runbin /tmp/f_rd.bin "$base")" = "$(cat "$base.out")" ] || bad="$bad ref-dbg"
  clang++ -std=c++20 -O2 -DMZ_RELEASE -I "$RT" -x c++ /tmp/f_rr.cpp -o /tmp/f_rr.bin 2>/dev/null && [ "$(runbin /tmp/f_rr.bin "$base")" = "$(cat "$base.out")" ] || bad="$bad ref-rel"
  clang++ -std=c++20 -O0              -I "$RT" -x c++ /tmp/f_m.cpp  -o /tmp/f_md.bin 2>/dev/null && [ "$(runbin /tmp/f_md.bin "$base")" = "$(cat "$base.out")" ] || bad="$bad mozc-dbg"
  clang++ -std=c++20 -O2 -DMZ_RELEASE -I "$RT" -x c++ /tmp/f_m.cpp  -o /tmp/f_mr.bin 2>/dev/null && [ "$(runbin /tmp/f_mr.bin "$base")" = "$(cat "$base.out")" ] || bad="$bad mozc-rel"
  if [ -z "$bad" ]; then ok=$((ok+1)); else fail=$((fail+1)); faillist="$faillist $base($bad )"; fi
done
echo "faithful (ref & mozc, debug & release, == golden): $ok ; failed: $fail"
[ -n "$faillist" ] && { echo "FAILS:$faillist"; exit 1; } || echo "ALL FAITHFUL"
