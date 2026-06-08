#!/bin/sh
# ============================================================================
#  Automatic self-play training loop with live progress.
# ----------------------------------------------------------------------------
#  Repeatedly runs `selfplay` through the binary wrapper (build/shogi-usi), which
#  loads weights.txt at startup and saves it after each round — so every round
#  resumes from the previous one and learning accumulates on disk. Ctrl-C stops
#  cleanly (the latest weights are already saved).
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

# one self-play round; prints "S:<n> G:<n> D:<n> mse=<final>" parsed from engine output
run_round() { printf 'selfplay\nquit\n' | "$WRAP" 2>/dev/null | awk '
  /results S:/ { for (i=1;i<=NF;i++){ if($i~/^S:/)s+=substr($i,3); if($i~/^G:/)g+=substr($i,3); if($i~/^D:/)d+=substr($i,3) } }
  /mse=/       { split($0,a,"mse="); m=a[2] }
  END          { printf "S:%d G:%d D:%d mse=%s", s, g, d, m }'; }

# Cold start: pretrain (regress to material eval) if there is no weights file yet.
if [ ! -f "$WEIGHTS" ]; then
  echo "== cold start: pretrain (train) — no $WEIGHTS yet =="
  printf 'train\nquit\n' | "$WRAP" 2>/dev/null | grep -E 'epoch|done' | tail -2
fi

echo "== self-play training loop (wrapper=$WRAP, weights=$WEIGHTS) =="
[ "$ROUNDS" -eq 0 ] && echo "   running forever — Ctrl-C to stop" || echo "   $ROUNDS rounds"

round=0; games=0; start=$(date +%s)
trap 't=$(( $(date +%s) - start )); echo; echo "== stopped: $round rounds, $games games, ${t}s — weights saved in $WEIGHTS =="; exit 0' INT

while [ "$ROUNDS" -eq 0 ] || [ "$round" -lt "$ROUNDS" ]; do
  round=$((round + 1))
  t0=$(date +%s)
  printf '[round %3d] running…\r' "$round"
  sum=$(run_round)
  dt=$(( $(date +%s) - t0 ))
  s=$(echo "$sum" | sed -n 's/.*S:\([0-9]*\).*/\1/p')
  g=$(echo "$sum" | sed -n 's/.*G:\([0-9]*\).*/\1/p')
  d=$(echo "$sum" | sed -n 's/.*D:\([0-9]*\).*/\1/p')
  mse=$(echo "$sum" | sed -n 's/.*mse=\([0-9.eE+-]*\).*/\1/p')
  games=$((games + s + g + d))
  printf '[round %3d] %3ds  games S:%s G:%s D:%s  final_mse=%s   (total %d games, %ds)\n' \
         "$round" "$dt" "$s" "$g" "$d" "$mse" "$games" "$(( $(date +%s) - start ))"
done
echo "== done: $round rounds, $games games — weights saved in $WEIGHTS =="
