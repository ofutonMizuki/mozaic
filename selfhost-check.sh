#!/bin/sh
# Self-hosting fixpoint check for the mozaic-written compiler (tests/cases/selfhost.mzc).
# gen1 = mozc built by the TS compiler; gen2 = mozc built by gen1; gen3 = mozc built by gen2.
# If gen2's source == gen3's source (byte-identical), the compiler reproduces itself: self-hosting.
set -e
cd "$(dirname "$0")"
MOZC=tests/cases/selfhost.mzc
node --disable-warning=ExperimentalWarning src/main.ts build "$MOZC" >/dev/null 2>&1   # gen1 -> build/selfhost
./build/selfhost < "$MOZC" > /tmp/mozc_gen2.cpp                                          # gen1 compiles mozc -> gen2 source
clang++ -std=c++20 -I runtime /tmp/mozc_gen2.cpp -o /tmp/mozc_gen2 2>/dev/null           # build gen2
/tmp/mozc_gen2 < "$MOZC" > /tmp/mozc_gen3.cpp                                            # gen2 compiles mozc -> gen3 source
if diff -q /tmp/mozc_gen2.cpp /tmp/mozc_gen3.cpp >/dev/null; then
  echo "OK: self-hosting fixpoint reached (gen2 == gen3); mozc reproduces itself."
else
  echo "FAIL: gen2 != gen3"; diff /tmp/mozc_gen2.cpp /tmp/mozc_gen3.cpp | head; exit 1
fi
