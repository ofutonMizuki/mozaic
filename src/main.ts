// mozaic M0 compiler — CLI driver.
// Pipeline: lex -> parse -> check(types) -> emit C++ -> (g++) -> native binary.
// Run directly with Node (no build step): `node src/main.ts <emit|build|run> <file.mzc> [--release]`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { lex } from "./lexer.ts";
import { Parser } from "./parser.ts";
import { check } from "./check.ts";
import { emit } from "./emit.ts";
import type { Program } from "./ast.ts";

function fail(msg: string): never { console.error(msg); process.exit(1); }

function main(): void {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const [cmd, file] = args.filter((a) => a !== "--release");
  if (!cmd || !file || !["emit", "build", "run"].includes(cmd)) {
    console.error("usage: mozaic <emit|build|run> <file.mzc> [--release]");
    process.exit(2);
  }
  const src = readFileSync(file, "utf8");
  let prog: Program;
  try {
    prog = new Parser(lex(src)).parseProgram();
  } catch (e) {
    return fail(String((e as Error).message));
  }
  const errs = check(prog);
  if (errs.length) return fail(errs.map((m) => "error: " + m).join("\n"));

  const cpp = emit(prog);
  if (cmd === "emit") { process.stdout.write(cpp); return; }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runtimeDir = join(root, "runtime");
  const buildDir = join(root, "build");
  mkdirSync(buildDir, { recursive: true });
  const base = basename(file).replace(/\.mzc$/, "");
  const cppPath = join(buildDir, base + ".cpp");
  const binPath = join(buildDir, base);
  writeFileSync(cppPath, cpp);
  const flags = ["-std=c++20", "-O2", "-I", runtimeDir];
  if (release) flags.push("-DMZ_RELEASE");
  flags.push("-o", binPath, cppPath);
  try {
    execFileSync("g++", flags, { stdio: "inherit" });
  } catch {
    return fail("C++ compile failed");
  }
  if (cmd === "build") { console.error(`built ${binPath}`); return; }
  const r = spawnSync(binPath, [], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

main();
