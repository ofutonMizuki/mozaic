#!/bin/sh
# ============================================================================
#  Automatic TD value-learning loop with a per-round strength gauge.
# ----------------------------------------------------------------------------
#  Each round runs `tdgauge` through the binary wrapper (build/shogi-usi):
#    1. loads weights.txt (resume), snapshots them,
#    2. runs TD(0) value learning over diverse RANDOM positions (bootstrapped via
#       a frozen target net — broad coverage, low variance, resists collapse),
#    3. plays the trained net vs the pre-round snapshot (1-ply self-match) and
#       prints a strength score, then the wrapper persists the new weights.
#
#  Reading the score:  >50% = this round improved play;  ~50% over many rounds
#  = converged (or step too small).  This is real-play strength, NOT final_mse
#  (which only measures fit to the round's own targets and can hide a collapse).
#
#  TD learns win-values in [-1,1] from scratch — do NOT material-pretrain first
#  (`train` uses a wider material scale and clashes). To start clean from an old
#  material-trained net:   rm -f shogi/weights.txt
#
#  Usage:   shogi/train-loop.sh [ROUNDS]      (ROUNDS omitted or 0 = run forever)
#  Env:     MZ_SHOGI_WEIGHTS  weights file (default shogi/weights.txt)
#           MZ_SHOGI_BIN      engine binary (default build/shogi) — passed to wrapper
# ============================================================================
set -u
cd "$(dirname "$0")/.."
WRAP=build/shogi-usi
WEIGHTS="${MZ_SHOGI_WEIGHTS:-shogi/weights.txt}"
ROUNDS="${1:-0}"

[ -x "$WRAP" ] || { echo "missing $WRAP — build it: npm run build:usi" >&2; exit 1; }

# Strength gauging (the 1-ply self-match) is pure measurement and is the slow part,
# so run it only every GAUGE_EVERY rounds; the other rounds just learn (`td`, fast).
GAUGE_EVERY="${MZ_GAUGE_EVERY:-5}"

run_td()    { printf 'td\nquit\n'      | "$WRAP" 2>/dev/null >/dev/null; }                # learn only
run_gauge() { printf 'tdgauge\nquit\n' | "$WRAP" 2>/dev/null | awk '                      # learn + gauge
  /score vs snapshot/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9.]+%$/) sc = $i }
  END { printf "%s", sc }'; }

echo "== TD value-learning loop (wrapper=$WRAP, weights=$WEIGHTS) =="
[ -f "$WEIGHTS" ] && echo "   resuming from $WEIGHTS" || echo "   starting fresh from built-in init"
[ "$ROUNDS" -eq 0 ] && echo "   running forever — Ctrl-C to stop" || echo "   $ROUNDS rounds"
echo "   gauging strength every $GAUGE_EVERY rounds (vs that round's starting net; >50% = improved)"

round=0; start=$(date +%s)
trap 't=$(( $(date +%s) - start )); echo; echo "== stopped: $round rounds, ${t}s — weights saved in $WEIGHTS =="; exit 0' INT

while [ "$ROUNDS" -eq 0 ] || [ "$round" -lt "$ROUNDS" ]; do
  round=$((round + 1))
  t0=$(date +%s)
  if [ $((round % GAUGE_EVERY)) -eq 0 ]; then
    printf '[round %3d] td + gauging…\r' "$round"
    sc=$(run_gauge)
    dt=$(( $(date +%s) - t0 ))
    printf '[round %3d] %3ds  TD + strength(vs round-start)=%-5s   (total %ds)\n' \
           "$round" "$dt" "${sc:-?}" "$(( $(date +%s) - start ))"
  else
    printf '[round %3d] td…\r' "$round"
    run_td
    dt=$(( $(date +%s) - t0 ))
    printf '[round %3d] %3ds  TD                                  (total %ds)\n' \
           "$round" "$dt" "$(( $(date +%s) - start ))"
  fi
done
echo "== done: $round rounds — weights saved in $WEIGHTS =="
