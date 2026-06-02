#!/bin/sh
# How many NEGATIVE (.err) goldens does mozc reject? mozc has only a partial checker, so a program is
# "rejected" if mozc errors (parse/check) OR the emitted C++ fails to compile. Lists the ones it misses.
set -e
cd "$(dirname "$0")"
node --disable-warning=ExperimentalWarning src/main.ts build tests/cases/selfhost.mzc >/dev/null 2>&1
ROOT="$(pwd)"; MOZC="$ROOT/build/selfhost"; RT="$ROOT/runtime"
cd tests/cases
rej=0; total=0; missed=""
for err in *.err; do
  base="${err%.err}"; total=$((total+1))
  if ! "$MOZC" < "$base.mzc" > /tmp/neg.cpp 2>/dev/null; then rej=$((rej+1)); continue; fi
  if ! clang++ -std=c++20 -x c++ -I "$RT" /tmp/neg.cpp -o /tmp/neg.bin 2>/dev/null; then rej=$((rej+1)); continue; fi
  missed="$missed $base"
done
echo "negatives mozc REJECTS: $rej/$total"
[ -n "$missed" ] && echo "MISSED:$missed" || true
