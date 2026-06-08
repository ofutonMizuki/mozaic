#!/usr/bin/env node
// ============================================================================
//  arena.mjs — parallel engine-vs-engine strength measurement.
// ----------------------------------------------------------------------------
//  Launches many SINGLE-THREADED engine processes (Threads=1) and plays full
//  games between two weight sets using the engine's REAL search (`go depth N`),
//  so strength reflects search + eval — not a 1-ply proxy. Games run C at a time
//  across CPU cores. Use the CPU build (build/shogi via `npm run build:shogi`):
//  the engine plays one position at a time, so host eval is fast and there is no
//  GPU contention between processes.
//
//  Usage:
//    node shogi/arena.mjs --a shogi/weights.txt --b init --games 40 --depth 4
//    node shogi/arena.mjs --a new.txt --b old.txt --games 60 --depth 4 -c 8
//
//  Args:  --engine PATH (default build/shogi)   --a FILE|init   --b FILE|init
//         --games N (default 40)   --depth D (default 4)   -c / --concurrency C
//         --maxmoves M (default 320)
//  A weight arg of "init" (or a missing file) = the engine's built-in init net.
//  Prints A's score% = (A_wins + 0.5*draws) / games.  >50% => A is stronger.
// ============================================================================
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

function parseArgs(argv) {
  const a = { engine: "build/shogi", a: "init", b: "init", games: 40, depth: 4,
              concurrency: Math.max(2, os.cpus().length), maxmoves: 320 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--engine") { a.engine = v; i++; }
    else if (k === "--a") { a.a = v; i++; }
    else if (k === "--b") { a.b = v; i++; }
    else if (k === "--games") { a.games = +v; i++; }
    else if (k === "--depth") { a.depth = +v; i++; }
    else if (k === "-c" || k === "--concurrency") { a.concurrency = +v; i++; }
    else if (k === "--maxmoves") { a.maxmoves = +v; i++; }
  }
  return a;
}

// "loadweights <ints>" line for a weights file, or null for the built-in init net.
function loadLineFor(spec) {
  if (!spec || spec === "init" || spec === "none") return null;
  if (!existsSync(spec)) { console.error(`(warn) weights '${spec}' not found — using built-in init`); return null; }
  const data = readFileSync(spec, "utf8").trim();
  return data ? "loadweights " + data : null;
}

class Engine {
  constructor(bin) {
    this.p = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.buf = "";
    this.waiters = [];                                   // {pred, resolve, reject, timer}
    this.dead = false;
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let idx;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).replace(/\r$/, "");
        this.buf = this.buf.slice(idx + 1);
        for (let i = 0; i < this.waiters.length; i++) {
          if (this.waiters[i].pred(line)) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(line); break; }
        }
      }
    });
    this.p.on("exit", () => { this.dead = true; this.waiters.forEach(w => { clearTimeout(w.timer); w.reject(new Error("engine exited")); }); this.waiters = []; });
  }
  send(s) { if (!this.dead) this.p.stdin.write(s + "\n"); }
  wait(pred, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: setTimeout(() => {
        const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timeout"));
      }, timeoutMs) };
      this.waiters.push(w);
    });
  }
  async init(loadLine) {
    this.send("usi"); await this.wait(l => l === "usiok");
    this.send("setoption name Threads value 1");
    if (loadLine) this.send(loadLine);
    this.send("isready"); await this.wait(l => l === "readyok");
  }
  kill() { try { this.send("quit"); } catch {} setTimeout(() => { try { this.p.kill(); } catch {} }, 150); }
}

// Play one game. Returns 'A' | 'B' | 'draw'. aIsSente decides A's color this game.
async function playGame(engA, engB, aIsSente, depth, maxMoves) {
  engA.send("usinewgame"); engB.send("usinewgame");
  const senteEng = aIsSente ? engA : engB;
  const goteEng = aIsSente ? engB : engA;
  const moves = [];
  for (let ply = 0; ply < maxMoves; ply++) {
    const mover = (ply % 2 === 0) ? senteEng : goteEng;
    mover.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
    mover.send(`go depth ${depth}`);
    const line = await mover.wait(l => l.startsWith("bestmove"));
    const mv = line.split(/\s+/)[1];
    if (!mv || mv === "resign" || mv === "win" || mv === "(none)") {
      const moverIsA = (mover === engA);                 // mover has no move => mover loses
      return moverIsA ? "B" : "A";
    }
    moves.push(mv);
  }
  // Move cap: adjudicate by OBJECTIVE material (not the nets' own eval — that would be circular).
  // `eval` prints sente-perspective material cp; |adv| > ADJ_CP decides, else a true draw.
  const ADJ_CP = 200;
  senteEng.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
  senteEng.send("eval");
  const el = await senteEng.wait(l => l.startsWith("evalcp"));
  const cp = parseInt(el.split(/\s+/)[1], 10) || 0;     // + favours sente
  if (cp > ADJ_CP) return aIsSente ? "A" : "B";
  if (cp < -ADJ_CP) return aIsSente ? "B" : "A";
  return "draw";
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (!existsSync(cfg.engine)) { console.error(`engine '${cfg.engine}' not found — build it (npm run build:shogi)`); process.exit(1); }
  const loadA = loadLineFor(cfg.a);
  const loadB = loadLineFor(cfg.b);
  const nameA = loadA ? cfg.a : "init";
  const nameB = loadB ? cfg.b : "init";
  console.log(`arena: A(${nameA}) vs B(${nameB})  games=${cfg.games}  depth=${cfg.depth}  concurrency=${cfg.concurrency}`);

  let next = 0, aWins = 0, bWins = 0, draws = 0, done = 0;
  const t0 = Date.now();
  async function worker() {
    const a = new Engine(cfg.engine); const b = new Engine(cfg.engine);
    try { await a.init(loadA); await b.init(loadB); } catch (e) { a.kill(); b.kill(); return; }
    while (true) {
      const g = next++; if (g >= cfg.games) break;
      const aIsSente = (g % 2 === 0);                    // alternate colors for fairness
      let r;
      try { r = await playGame(a, b, aIsSente, cfg.depth, cfg.maxmoves); }
      catch (e) { r = "draw"; }                          // hang/crash => void as draw
      if (r === "A") aWins++; else if (r === "B") bWins++; else draws++;
      done++;
      process.stderr.write(`  ${done}/${cfg.games}  A:${aWins} B:${bWins} D:${draws}\r`);
    }
    a.kill(); b.kill();
  }
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  const score = (aWins + 0.5 * draws) / Math.max(1, aWins + bWins + draws);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  process.stderr.write("\n");
  console.log(`result: A(${nameA}) W:${aWins} L:${bWins} D:${draws}  A-score=${(score * 100).toFixed(1)}%  (${secs}s)  ${score > 0.5 ? "A stronger" : score < 0.5 ? "B stronger" : "even"}`);
}

main();
