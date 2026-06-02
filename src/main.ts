// mozaic M0 compiler — CLI driver.
// Pipeline: lex -> parse -> check(types) -> emit C++ -> (g++) -> native binary.
// Run directly with Node (no build step): `node src/main.ts <emit|build|run> <file.mzc> [--release]`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { platform } from "node:os";
import { lex } from "./lexer.ts";
import { Parser } from "./parser.ts";
import { check } from "./check.ts";
import { emit } from "./emit.ts";
import type { Program, Item } from "./ast.ts";

function fail(msg: string): never { console.error(msg); process.exit(1); }

// Resolve `import "path";` items by parsing each referenced file once (dedup by absolute path,
// relative to the importing file) and merging all non-import items — dependencies first.
function loadProgram(entry: string): Program {
  const seen = new Set<string>();
  const items: Item[] = [];
  const load = (filePath: string, importedFrom: string | null) => {
    const abs = resolve(filePath);
    if (seen.has(abs)) return;
    seen.add(abs);
    let src: string;
    try { src = readFileSync(abs, "utf8"); }
    catch { return fail(importedFrom ? `cannot import '${filePath}' (from ${importedFrom})` : `cannot read ${filePath}`); }
    let prog: Program;
    try { prog = new Parser(lex(src)).parseProgram(); }
    catch (e) { return fail(`${abs}: ${String((e as Error).message)}`); }
    const dir = dirname(abs);
    for (const it of prog.items) {
      if (it.kind === "Import") load(join(dir, it.path), abs);   // paths are relative to the importing file
      else items.push(it);
    }
  };
  load(entry, null);
  return { kind: "Program", items };
}

function main(): void {
  const args = process.argv.slice(2);
  const FLAGS = new Set(["--release", "--gpu", "--metal"]);
  const release = args.includes("--release");
  const metal = args.includes("--gpu") || args.includes("--metal");
  const [cmd, file] = args.filter((a) => !FLAGS.has(a));
  if (!cmd || !file || !["emit", "build", "run"].includes(cmd)) {
    console.error("usage: mozaic <emit|build|run> <file.mzc> [--release] [--gpu|--metal]");
    process.exit(2);
  }
  if (metal && platform() !== "darwin") return fail("--gpu/--metal requires macOS (Apple Silicon)");
  const prog = loadProgram(file);
  const errs = check(prog, metal ? "metal" : "cpu");
  if (errs.length) return fail(errs.map((m) => "error: " + m).join("\n"));

  const cpp = emit(prog, metal ? "metal" : "cpu");
  if (cmd === "emit") { process.stdout.write(cpp); return; }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const runtimeDir = join(root, "runtime");
  const buildDir = join(root, "build");
  mkdirSync(buildDir, { recursive: true });
  const base = basename(file).replace(/\.mzc$/, "");
  // Metal: compile the generated unit as Objective-C++ (it imports <Metal/Metal.h>).
  const srcPath = join(buildDir, base + (metal ? ".mm" : ".cpp"));
  const binPath = join(buildDir, base);
  writeFileSync(srcPath, cpp);

  // Compiler + flags are overridable via MZ_CXX / MZ_CXXFLAGS. Default to clang++ on macOS.
  const cxx = process.env.MZ_CXX || (platform() === "darwin" ? "clang++" : "g++");
  // Release builds opt harder (-O3): wrapping overflow has no traps to schedule around and the strict
  // no-alias/exhaustiveness hints (__restrict / __builtin_unreachable) give -O3 more to work with.
  const flags = ["-std=c++20", release ? "-O3" : "-O2", "-I", runtimeDir];
  if (release) flags.push("-DMZ_RELEASE");
  if (!metal && platform() !== "darwin") flags.push("-pthread");   // std::thread (spawn) on Linux g++
  if (metal) flags.push("-DMZ_METAL", "-x", "objective-c++", "-fobjc-arc",
                        "-framework", "Metal", "-framework", "Foundation");
  if (process.env.MZ_CXXFLAGS) flags.push(...process.env.MZ_CXXFLAGS.split(/\s+/).filter(Boolean));
  flags.push("-o", binPath, srcPath);
  try {
    execFileSync(cxx, flags, { stdio: "inherit" });
  } catch {
    return fail("C++ compile failed");
  }
  if (cmd === "build") { console.error(`built ${binPath}${metal ? " [Metal]" : ""}`); return; }
  const r = spawnSync(binPath, [], { stdio: "inherit" });
  process.exit(r.status ?? (r.signal ? 1 : 0));   // a signal-killed child (e.g. abort()) is a failure, not 0
}

main();
