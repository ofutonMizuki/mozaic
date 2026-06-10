#!/bin/sh
# ============================================================================
#  Self-play training loop.
# ----------------------------------------------------------------------------
#  Cold start: one squashed-material pretrain (`train`) to ground the net in the
#  SAME [-1,1] scale that self-play outcome labels use (so pretrain feeds into
#  self-play without the scale clash that collapsed the old pipeline).
#  Then each round runs `selfplay`: plays self-play games and regresses each
#  position toward its GAME OUTCOME (+1/-1/0, sente view) — the learning signal
#  stays the self-play result. Weights persist to weights.txt; rounds resume.
#
#  Strength is NOT shown here (final_mse is fit, not strength). Measure it with
#  the arena (parallel engine-vs-engine, real search):
#    node shogi/arena.mjs --a shogi/weights.txt --b init --games 20 --depth 2
#
#  Usage:   shogi/train-loop.sh [ROUNDS]      (0/omitted = forever)
#  Env:     MZ_SHOGI_WEIGHTS  weights file   MZ_SHOGI_BIN  engine binary
# ============================================================================
set -u
cd "$(dirname "$0")/.."
WRAP=build/shogi-usi
WEIGHTS="${MZ_SHOGI_WEIGHTS:-shogi/weights.txt}"
ROUNDS="${1:-0}"

[ -x "$WRAP" ] || { echo "missing $WRAP — build it: npm run build:usi" >&2; exit 1; }

# one self-play round; prints "S:<n> G:<n> D:<n> mse=<final>" parsed from engine output
run_round() { printf 'selfplay\nquit\n' | "$WRAP" 2>/dev/null | awk '
  /selfplay iter/ { for (i=1;i<=NF;i++){ if($i~/^S:/)s+=substr($i,3); if($i~/^G:/)g+=substr($i,3); if($i~/^D:/)d+=substr($i,3) } }
  /mse=/          { split($0,a,"mse="); m=a[2] }
  END             { printf "S:%d G:%d D:%d mse=%s", s, g, d, m }'; }

# Cold start: squashed-material pretrain if there is no weights file yet.
if [ ! -f "$WEIGHTS" ]; then
  echo "== cold start: squashed-material pretrain (train) — no $WEIGHTS yet =="
  printf 'train\nquit\n' | "$WRAP" 2>/dev/null | grep -E 'epoch|done' | tail -2
fi

echo "== self-play training loop (wrapper=$WRAP, weights=$WEIGHTS) =="
[ "$ROUNDS" -eq 0 ] && echo "   running forever — Ctrl-C to stop" || echo "   $ROUNDS rounds"
echo "   measure strength with: node shogi/arena.mjs --a $WEIGHTS --b init --games 20 --depth 2"

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
