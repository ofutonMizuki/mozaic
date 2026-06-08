#!/usr/bin/env node
// ============================================================================
//  External USI wrapper for the mozaic shogi engine.
// ----------------------------------------------------------------------------
//  The mozaic runtime is stdio-only (no file I/O), so this wrapper supplies the
//  two things the engine cannot do itself — both in an external language (Node):
//    1. Weight PERSISTENCE (file I/O): loads weights from a file at startup
//       (`loadweights`), and saves them after `train` (`dumpweights` -> file).
//    2. GUI bridge: a transparent USI passthrough between a GUI and the engine,
//       running engine<->GUI on independent line pumps.
//
//  A USI GUI (ShogiGUI / 将棋所) launches THIS script as the engine:
//      node shogi/usi.mjs
//  and it transparently drives ../build/shogi with persistent learned weights.
//
//  Env overrides:
//    MZ_SHOGI_BIN      path to the engine binary (default ../build/shogi)
//    MZ_SHOGI_WEIGHTS  path to the weights file  (default ./weights.txt)
// ============================================================================
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.MZ_SHOGI_BIN || join(HERE, "..", "build", "shogi");
const WEIGHTS = process.env.MZ_SHOGI_WEIGHTS || join(HERE, "weights.txt");
const log = (m) => process.stderr.write(`info string [wrap] ${m}\n`);   // wrapper logs -> stderr (keep stdout = pure USI)

const eng = spawn(ENGINE, [], { stdio: ["pipe", "pipe", "inherit"] });
const send = (line) => { eng.stdin.write(line + "\n"); };

// engine -> GUI. Intercept the `weights <count> <ints...>` dump (persist it, do NOT forward).
createInterface({ input: eng.stdout }).on("line", (line) => {
  if (line.startsWith("weights ")) {
    const ints = line.slice("weights ".length).split(" ").slice(1).join(" ");  // drop the leading count
    writeFileSync(WEIGHTS, ints + "\n");
    log(`saved ${ints.split(" ").length} weights -> ${WEIGHTS}`);
  } else {
    process.stdout.write(line + "\n");
  }
});

// Load persisted weights into the engine before any GUI traffic.
if (existsSync(WEIGHTS)) {
  const data = readFileSync(WEIGHTS, "utf8").trim();
  if (data) { send("loadweights " + data); log(`loaded weights <- ${WEIGHTS}`); }
} else {
  log(`no weights file (${WEIGHTS}); engine starts from its built-in init — run 'train' to create one`);
}

// GUI -> engine. Pass through; after train/selfplay, ask the engine to dump its weights.
// selfplay needs a FRESH RNG seed each round (the engine is pure-stdio, no clock) — inject one
// here, else every round replays identical games and final_mse freezes at a fixed point.
let seedCtr = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const c = line.trim();
  if (c === "selfplay") {
    const seed = ((Date.now() * 1000003 + (seedCtr++)) >>> 0) & 0x7fffffff;   // 時刻+カウンタ, i32 範囲
    send("selfplay " + seed);
    send("dumpweights");
  } else {
    send(line);
    if (c === "train") send("dumpweights");   // persist learned weights
  }
});

eng.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => { try { send("quit"); } catch {} });
