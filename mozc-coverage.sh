#!/bin/sh
# Measure how many POSITIVE goldens (.out) the mozaic-written compiler (mozc) can compile correctly.
# For each case with a .out, run mozc -> C++ -> clang++ -> binary -> compare stdout (feeding .in if present).
# This is the self-hosting completeness metric (negatives/.err require the type/borrow-checker port).
set -e
cd "$(dirname "$0")"
node --disable-warning=ExperimentalWarning src/main.ts build tests/cases/selfhost.mzc >/dev/null 2>&1
MOZC=./build/selfhost
pass=0; total=0; fails=""
for mzc in tests/cases/*.mzc; do
  base="${mzc%.mzc}"
  [ -f "$base.out" ] || continue          # positive goldens only
  name="$(basename "$base")"
  total=$((total+1))
  if ! "$MOZC" < "$mzc" > "/tmp/cov.cpp" 2>/dev/null; then fails="$fails $name(emit)"; continue; fi
  if ! clang++ -std=c++20 -I runtime "/tmp/cov.cpp" -o "/tmp/cov.bin" 2>/dev/null; then fails="$fails $name(cc)"; continue; fi
  if [ -f "$base.in" ]; then "/tmp/cov.bin" < "$base.in" > "/tmp/cov.run" 2>&1 || true
  else "/tmp/cov.bin" > "/tmp/cov.run" 2>&1 || true; fi
  if diff -q "/tmp/cov.run" "$base.out" >/dev/null 2>&1; then pass=$((pass+1)); else fails="$fails $name(diff)"; fi
done
echo "mozc positive-golden coverage: $pass/$total"
[ -n "$fails" ] && echo "FAILS:$fails" || true
