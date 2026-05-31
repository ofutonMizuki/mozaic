// mozaic M0 compiler — single-file walking skeleton.
// Pipeline: lex -> parse -> check -> emit C++ -> (g++) -> native binary.
// Implementation language: TypeScript, run directly by Node (no build step).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

// ---------- AST (types erased at runtime) ----------
type Program = { kind: "Program"; items: FnDecl[] };
type FnDecl = { kind: "FnDecl"; name: string; body: Stmt[] };
type Stmt =
  | { kind: "ForOf"; binder: string; iter: Expr; body: Stmt[] }
  | { kind: "If"; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { kind: "Return"; value: Expr | null }
  | { kind: "Break" }
  | { kind: "Continue" }
  | { kind: "ExprStmt"; expr: Expr };
type Expr =
  | { kind: "Str"; value: string }
  | { kind: "Ident"; name: string }
  | { kind: "Member"; obj: Expr; prop: string }
  | { kind: "Call"; callee: Expr; args: Expr[] }
  | { kind: "Binary"; op: string; left: Expr; right: Expr };

// ---------- Lexer ----------
type Tok = { t: string; v: string; pos: number };
const KEYWORDS = new Set(["fn", "for", "of", "if", "else", "return", "break", "continue", "const", "let"]);

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"') {
      i++;
      let s = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\") {
          const e = src[i + 1];
          if (e === "n") s += "\n";
          else if (e === "t") s += "\t";
          else if (e === "r") s += "\r";
          else if (e === '"') s += '"';
          else if (e === "\\") s += "\\";
          else s += e;
          i += 2;
        } else { s += src[i]; i++; }
      }
      i++;
      toks.push({ t: "str", v: s, pos: i });
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      const w = src.slice(i, j);
      toks.push({ t: KEYWORDS.has(w) ? w : "id", v: w, pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=") { toks.push({ t: two, v: two, pos: i }); i += 2; continue; }
    if ("(){};,.=".includes(c)) { toks.push({ t: c, v: c, pos: i }); i++; continue; }
    throw new Error(`lex error: unexpected '${c}' at ${i}`);
  }
  toks.push({ t: "eof", v: "", pos: n });
  return toks;
}

// ---------- Parser (recursive descent) ----------
class Parser {
  toks: Tok[];
  i: number;
  constructor(toks: Tok[]) { this.toks = toks; this.i = 0; }
  peek(): Tok { return this.toks[this.i]; }
  at(t: string): boolean { return this.toks[this.i].t === t; }
  next(): Tok { return this.toks[this.i++]; }
  eat(t: string): Tok {
    const tk = this.toks[this.i];
    if (tk.t !== t) throw new Error(`parse error: expected '${t}' but got '${tk.t}' ('${tk.v}') at ${tk.pos}`);
    this.i++;
    return tk;
  }
  parseProgram(): Program {
    const items: FnDecl[] = [];
    while (!this.at("eof")) items.push(this.parseFn());
    return { kind: "Program", items };
  }
  parseFn(): FnDecl {
    this.eat("fn");
    const name = this.eat("id").v;
    this.eat("("); this.eat(")");
    return { kind: "FnDecl", name, body: this.parseBlock() };
  }
  parseBlock(): Stmt[] {
    this.eat("{");
    const stmts: Stmt[] = [];
    while (!this.at("}")) stmts.push(this.parseStmt());
    this.eat("}");
    return stmts;
  }
  parseStmt(): Stmt {
    const t = this.peek().t;
    if (t === "for") return this.parseFor();
    if (t === "if") return this.parseIf();
    if (t === "return") {
      this.next();
      let value: Expr | null = null;
      if (!this.at(";")) value = this.parseExpr();
      this.eat(";");
      return { kind: "Return", value };
    }
    if (t === "break") { this.next(); this.eat(";"); return { kind: "Break" }; }
    if (t === "continue") { this.next(); this.eat(";"); return { kind: "Continue" }; }
    const expr = this.parseExpr();
    this.eat(";");
    return { kind: "ExprStmt", expr };
  }
  parseFor(): Stmt {
    this.eat("for"); this.eat("(");
    if (this.at("const")) this.next(); else if (this.at("let")) this.next();
    const binder = this.eat("id").v;
    this.eat("of");
    const iter = this.parseExpr();
    this.eat(")");
    return { kind: "ForOf", binder, iter, body: this.parseBlock() };
  }
  parseIf(): Stmt {
    this.eat("if"); this.eat("(");
    const cond = this.parseExpr();
    this.eat(")");
    const then = this.parseBlock();
    let els: Stmt[] | null = null;
    if (this.at("else")) { this.next(); els = this.parseBlock(); }
    return { kind: "If", cond, then, els };
  }
  parseExpr(): Expr { return this.parseEquality(); }
  parseEquality(): Expr {
    let left = this.parsePostfix();
    while (this.at("==") || this.at("!=")) {
      const op = this.next().t;
      left = { kind: "Binary", op, left, right: this.parsePostfix() };
    }
    return left;
  }
  parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at(".")) { this.next(); e = { kind: "Member", obj: e, prop: this.eat("id").v }; }
      else if (this.at("(")) {
        this.next();
        const args: Expr[] = [];
        if (!this.at(")")) {
          args.push(this.parseExpr());
          while (this.at(",")) { this.next(); args.push(this.parseExpr()); }
        }
        this.eat(")");
        e = { kind: "Call", callee: e, args };
      } else break;
    }
    return e;
  }
  parsePrimary(): Expr {
    const tk = this.peek();
    if (tk.t === "str") { this.next(); return { kind: "Str", value: tk.v }; }
    if (tk.t === "id") { this.next(); return { kind: "Ident", name: tk.v }; }
    if (tk.t === "(") { this.next(); const e = this.parseExpr(); this.eat(")"); return e; }
    throw new Error(`parse error: unexpected '${tk.t}' ('${tk.v}') at ${tk.pos}`);
  }
}

// ---------- Check (minimal) ----------
function check(prog: Program): string[] {
  const errs: string[] = [];
  if (!prog.items.some((f) => f.name === "main")) errs.push("no `main` function");
  return errs;
}

// ---------- Emit C++ ----------
function cstr(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out + '"';
}

function isStdinLines(e: Expr): boolean {
  return e.kind === "Call" && e.callee.kind === "Member" &&
    e.callee.obj.kind === "Ident" && e.callee.obj.name === "stdin" && e.callee.prop === "lines";
}

function emitExpr(e: Expr): string {
  switch (e.kind) {
    case "Str": return cstr(e.value);
    case "Ident": return e.name;
    case "Member": return `${emitExpr(e.obj)}.${e.prop}`;
    case "Binary": {
      const l = emitExpr(e.left), r = emitExpr(e.right);
      if (e.op === "==") return `mz::eq(${l}, ${r})`;
      if (e.op === "!=") return `(!mz::eq(${l}, ${r}))`;
      return `(${l} ${e.op} ${r})`;
    }
    case "Call": {
      if (e.callee.kind === "Member" && e.callee.obj.kind === "Ident") {
        const recv = e.callee.obj.name, m = e.callee.prop;
        if (recv === "stdout" && m === "println") return `mz::println(${e.args.map(emitExpr).join(", ")})`;
      }
      return `${emitExpr(e.callee)}(${e.args.map(emitExpr).join(", ")})`;
    }
  }
}

function emitStmt(s: Stmt, ind: string): string {
  switch (s.kind) {
    case "ForOf": {
      if (!isStdinLines(s.iter)) throw new Error("M0: only `stdin.lines()` is iterable");
      const body = s.body.map((st) => emitStmt(st, ind + "  ")).join("\n");
      return `${ind}for (mz::String ${s.binder} : mz::stdin_lines()) {\n${body}\n${ind}}`;
    }
    case "If": {
      const then = s.then.map((st) => emitStmt(st, ind + "  ")).join("\n");
      let out = `${ind}if (${emitExpr(s.cond)}) {\n${then}\n${ind}}`;
      if (s.els) out += ` else {\n${s.els.map((st) => emitStmt(st, ind + "  ")).join("\n")}\n${ind}}`;
      return out;
    }
    case "Return": return `${ind}return 0;`;
    case "Break": return `${ind}break;`;
    case "Continue": return `${ind}continue;`;
    case "ExprStmt": return `${ind}${emitExpr(s.expr)};`;
  }
}

function emit(prog: Program): string {
  const main = prog.items.find((f) => f.name === "main")!;
  const body = main.body.map((s) => emitStmt(s, "  ")).join("\n");
  return `// generated by mozaic (M0)
#include "mozaic_rt.h"

int main() {
${body}
  return 0;
}
`;
}

// ---------- Driver ----------
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main(): void {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !file || !["emit", "build", "run"].includes(cmd)) {
    console.error("usage: mozaic <emit|build|run> <file.moz>");
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
  const base = basename(file).replace(/\.moz$/, "");
  const cppPath = join(buildDir, base + ".cpp");
  const binPath = join(buildDir, base);
  writeFileSync(cppPath, cpp);
  try {
    execFileSync("g++", ["-std=c++17", "-O2", "-I", runtimeDir, "-o", binPath, cppPath], { stdio: "inherit" });
  } catch {
    return fail("C++ compile failed");
  }
  if (cmd === "build") { console.error(`built ${binPath}`); return; }
  const r = spawnSync(binPath, [], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

main();
