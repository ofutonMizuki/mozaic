// mozaic M0 compiler — single-file.
// Pipeline: lex -> parse -> check(types) -> emit C++ -> (g++) -> native binary.
// Implementation language: TypeScript, run directly by Node (no build step).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

// ---------- AST (types erased at runtime) ----------
type Program = { kind: "Program"; items: Item[] };
type Item = FnDecl | StructDecl | EnumDecl;
type Param = { name: string; ty: string };
type Field = { name: string; ty: string };
type Variant = { name: string; payload: string[] };
type StructDecl = { kind: "StructDecl"; name: string; fields: Field[] };
type EnumDecl = { kind: "EnumDecl"; name: string; variants: Variant[] };
type FnDecl = { kind: "FnDecl"; name: string; params: Param[]; retTy: string | null; body: Stmt[] };
type Arm = { variant: string; bindings: string[]; body: Stmt[] };
type Stmt =
  | { kind: "Let"; name: string; annot: string | null; value: Expr; declTy?: string }
  | { kind: "Assign"; name: string; value: Expr }
  | { kind: "While"; cond: Expr; body: Stmt[] }
  | { kind: "ForOf"; binder: string; iter: Expr; body: Stmt[] }
  | { kind: "If"; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { kind: "Match"; scrut: Expr; arms: Arm[] }
  | { kind: "Return"; value: Expr | null }
  | { kind: "Break" }
  | { kind: "Continue" }
  | { kind: "ExprStmt"; expr: Expr };
type Expr =
  | { kind: "Num"; value: string; ty?: string }
  | { kind: "Float"; value: string; ty?: string }
  | { kind: "Str"; value: string; ty?: string }
  | { kind: "Ident"; name: string; ty?: string }
  | { kind: "Member"; obj: Expr; prop: string; ty?: string }
  | { kind: "Call"; callee: Expr; args: Expr[]; ty?: string }
  | { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[]; ty?: string }
  | { kind: "Binary"; op: string; left: Expr; right: Expr; ty?: string };

// ---------- Types ----------
const INTS = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64"];
const FLOATS = ["f32", "f64"];
function isInt(t: string): boolean { return t === "intlit" || INTS.includes(t); }
function isFloat(t: string): boolean { return t === "floatlit" || FLOATS.includes(t); }
function isUnsigned(t: string): boolean { return t !== "intlit" && t.startsWith("u"); }
function unifyInt(a: string, b: string): string | null {
  if (!isInt(a) || !isInt(b)) return null;
  if (a === "intlit") return b;
  if (b === "intlit") return a;
  return a === b ? a : null;
}
function unifyFloat(a: string, b: string): string | null {
  if (!isFloat(a) || !isFloat(b)) return null;
  if (a === "floatlit") return b;
  if (b === "floatlit") return a;
  return a === b ? a : null;
}
function cppType(t: string): string {
  switch (t) {
    case "i8": return "int8_t"; case "i16": return "int16_t"; case "i32": return "int32_t"; case "i64": return "int64_t";
    case "u8": return "uint8_t"; case "u16": return "uint16_t"; case "u32": return "uint32_t"; case "u64": return "uint64_t";
    case "intlit": return "int32_t";
    case "f32": return "float"; case "f64": return "double"; case "floatlit": return "double";
    case "bool": return "bool";
    case "str": return "mz::String";
    default: return t;   // user struct/enum types map to their own name
  }
}
const BUILTIN_TYPES = new Set([...INTS, ...FLOATS, "bool", "str"]);
const ARITH_OPS = ["+", "-", "*", "/", "%", "+%", "-%", "*%", "+|", "-|", "*|"];
// integer arithmetic op -> runtime helper. default +/-/* trap(debug)/wrap(release);
// +%/-%/*% always wrap; +|/-|/*| saturate; / and % trap on /0 and MIN/-1.
const ARITH_FN: Record<string, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "divi", "%": "modi",
  "+%": "wadd", "-%": "wsub", "*%": "wmul",
  "+|": "sadd", "-|": "ssub", "*|": "smul",
};

// ---------- Lexer ----------
type Tok = { t: string; v: string; pos: number };
const KEYWORDS = new Set(["function", "struct", "enum", "match", "for", "while", "of", "if", "else", "return", "break", "continue", "const", "let"]);

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
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9_]/.test(src[j])) j++;
      let flt = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1])) {
        flt = true; j++;
        while (j < n && /[0-9_]/.test(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        flt = true; j++;
        if (src[j] === "+" || src[j] === "-") j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ t: flt ? "fnum" : "num", v: src.slice(i, j).replace(/_/g, ""), pos: i });
      i = j;
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
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "=>" ||
        two === "+%" || two === "-%" || two === "*%" || two === "+|" || two === "-|" || two === "*|") {
      toks.push({ t: two, v: two, pos: i }); i += 2; continue;
    }
    if ("(){};:,.=+-*/%<>".includes(c)) { toks.push({ t: c, v: c, pos: i }); i++; continue; }
    throw new Error(`lex error: unexpected '${c}' at ${i}`);
  }
  toks.push({ t: "eof", v: "", pos: n });
  return toks;
}

// ---------- Parser (recursive descent) ----------
class Parser {
  toks: Tok[];
  i: number;
  noStruct = false;   // when true, `Ident {` is NOT a struct literal (used for match scrutinee)
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
    const items: Item[] = [];
    while (!this.at("eof")) {
      if (this.at("struct")) items.push(this.parseStruct());
      else if (this.at("enum")) items.push(this.parseEnum());
      else items.push(this.parseFn());
    }
    return { kind: "Program", items };
  }
  parseStruct(): StructDecl {
    this.eat("struct");
    const name = this.eat("id").v;
    this.eat("{");
    const fields: Field[] = [];
    while (!this.at("}")) {
      const fname = this.eat("id").v;
      this.eat(":");
      const ty = this.eat("id").v;
      this.eat(";");
      fields.push({ name: fname, ty });
    }
    this.eat("}");
    return { kind: "StructDecl", name, fields };
  }
  parseEnum(): EnumDecl {
    this.eat("enum");
    const name = this.eat("id").v;
    this.eat("{");
    const variants: Variant[] = [];
    while (!this.at("}")) {
      const vn = this.eat("id").v;
      const payload: string[] = [];
      if (this.at("(")) {
        this.next();
        if (!this.at(")")) { payload.push(this.eat("id").v); while (this.at(",")) { this.next(); payload.push(this.eat("id").v); } }
        this.eat(")");
      }
      variants.push({ name: vn, payload });
      if (this.at(",")) this.next(); else break;
    }
    this.eat("}");
    return { kind: "EnumDecl", name, variants };
  }
  parseFn(): FnDecl {
    this.eat("function");
    const name = this.eat("id").v;
    this.eat("(");
    const params: Param[] = [];
    if (!this.at(")")) {
      params.push(this.parseParam());
      while (this.at(",")) { this.next(); params.push(this.parseParam()); }
    }
    this.eat(")");
    let retTy: string | null = null;
    if (this.at(":")) { this.next(); retTy = this.eat("id").v; }
    return { kind: "FnDecl", name, params, retTy, body: this.parseBlock() };
  }
  parseParam(): Param {
    const name = this.eat("id").v;
    this.eat(":");
    return { name, ty: this.eat("id").v };
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
    if (t === "while") return this.parseWhile();
    if (t === "if") return this.parseIf();
    if (t === "match") return this.parseMatch();
    if (t === "let" || t === "const") return this.parseLet();
    if (t === "return") {
      this.next();
      let value: Expr | null = null;
      if (!this.at(";")) value = this.parseExpr();
      this.eat(";");
      return { kind: "Return", value };
    }
    if (t === "break") { this.next(); this.eat(";"); return { kind: "Break" }; }
    if (t === "continue") { this.next(); this.eat(";"); return { kind: "Continue" }; }
    const e = this.parseExpr();
    if (this.at("=")) {
      this.next();
      const value = this.parseExpr();
      this.eat(";");
      if (e.kind !== "Ident") throw new Error("parse error: invalid assignment target");
      return { kind: "Assign", name: e.name, value };
    }
    this.eat(";");
    return { kind: "ExprStmt", expr: e };
  }
  parseLet(): Stmt {
    this.next();
    const name = this.eat("id").v;
    let annot: string | null = null;
    if (this.at(":")) { this.next(); annot = this.eat("id").v; }
    this.eat("=");
    const value = this.parseExpr();
    this.eat(";");
    return { kind: "Let", name, annot, value };
  }
  parseWhile(): Stmt {
    this.eat("while"); this.eat("(");
    const cond = this.parseExpr();
    this.eat(")");
    return { kind: "While", cond, body: this.parseBlock() };
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
  parseMatch(): Stmt {
    this.eat("match");
    this.noStruct = true;
    const scrut = this.parseExpr();
    this.noStruct = false;
    this.eat("{");
    const arms: Arm[] = [];
    while (!this.at("}")) {
      const variant = this.eat("id").v;
      const bindings: string[] = [];
      if (this.at("(")) {
        this.next();
        if (!this.at(")")) { bindings.push(this.eat("id").v); while (this.at(",")) { this.next(); bindings.push(this.eat("id").v); } }
        this.eat(")");
      }
      this.eat("=>");
      arms.push({ variant, bindings, body: this.parseBlock() });
    }
    this.eat("}");
    return { kind: "Match", scrut, arms };
  }
  parseExpr(): Expr { return this.parseComparison(); }
  parseComparison(): Expr {
    let left = this.parseAdditive();
    while (this.at("==") || this.at("!=") || this.at("<") || this.at("<=") || this.at(">") || this.at(">=")) {
      const op = this.next().t;
      left = { kind: "Binary", op, left, right: this.parseAdditive() };
    }
    return left;
  }
  parseAdditive(): Expr {
    let left = this.parseMul();
    while (this.at("+") || this.at("-") || this.at("+%") || this.at("-%") || this.at("+|") || this.at("-|")) {
      const op = this.next().t;
      left = { kind: "Binary", op, left, right: this.parseMul() };
    }
    return left;
  }
  parseMul(): Expr {
    let left = this.parsePostfix();
    while (this.at("*") || this.at("/") || this.at("%") || this.at("*%") || this.at("*|")) {
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
    if (tk.t === "num") { this.next(); return { kind: "Num", value: tk.v }; }
    if (tk.t === "fnum") { this.next(); return { kind: "Float", value: tk.v }; }
    if (tk.t === "str") { this.next(); return { kind: "Str", value: tk.v }; }
    if (tk.t === "id") {
      this.next();
      if (this.at("{") && !this.noStruct) return this.parseStructLit(tk.v);
      return { kind: "Ident", name: tk.v };
    }
    if (tk.t === "(") { this.next(); const e = this.parseExpr(); this.eat(")"); return e; }
    throw new Error(`parse error: unexpected '${tk.t}' ('${tk.v}') at ${tk.pos}`);
  }
  parseStructLit(name: string): Expr {
    this.eat("{");
    const fields: { name: string; value: Expr }[] = [];
    while (!this.at("}")) {
      const fname = this.eat("id").v;
      this.eat(":");
      fields.push({ name: fname, value: this.parseExpr() });
      if (this.at(",")) this.next(); else break;
    }
    this.eat("}");
    return { kind: "StructLit", name, fields };
  }
}

// ---------- Check (names + strict types) ----------
function isStdinLines(e: Expr): boolean {
  return e.kind === "Call" && e.callee.kind === "Member" &&
    e.callee.obj.kind === "Ident" && e.callee.obj.name === "stdin" && e.callee.prop === "lines";
}

type Sig = { params: Param[]; retTy: string | null };
type VarInfo = { enumName: string; index: number; payload: string[] };

class Checker {
  errs: string[] = [];
  scopes: Map<string, string>[] = [];
  fns = new Map<string, Sig>();
  structs = new Map<string, Map<string, string>>();
  enums = new Map<string, Map<string, string[]>>();       // enum -> (variant -> payload types)
  variants = new Map<string, VarInfo>();                  // variant -> info
  curRet = "unit";
  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }
  define(n: string, t: string) { this.scopes[this.scopes.length - 1].set(n, t); }
  lookup(n: string): string | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const t = this.scopes[i].get(n); if (t) return t; }
    return null;
  }
  err(m: string) { this.errs.push(m); }
  typeKnown(t: string): boolean { return BUILTIN_TYPES.has(t) || this.structs.has(t) || this.enums.has(t); }

  checkProgram(p: Program) {
    for (const it of p.items) if (it.kind === "StructDecl") {
      if (this.structs.has(it.name)) this.err(`duplicate struct '${it.name}'`);
      const fm = new Map<string, string>();
      for (const f of it.fields) fm.set(f.name, f.ty);
      this.structs.set(it.name, fm);
    }
    for (const it of p.items) if (it.kind === "EnumDecl") {
      if (this.enums.has(it.name)) this.err(`duplicate enum '${it.name}'`);
      const vm = new Map<string, string[]>();
      it.variants.forEach((v, idx) => {
        if (this.variants.has(v.name)) this.err(`duplicate variant name '${v.name}'`);
        vm.set(v.name, v.payload);
        this.variants.set(v.name, { enumName: it.name, index: idx, payload: v.payload });
      });
      this.enums.set(it.name, vm);
    }
    for (const it of p.items) if (it.kind === "StructDecl")
      for (const f of it.fields) if (!this.typeKnown(f.ty)) this.err(`unknown type '${f.ty}' for field '${it.name}.${f.name}'`);
    for (const it of p.items) if (it.kind === "EnumDecl")
      for (const v of it.variants) for (const pt of v.payload) if (!this.typeKnown(pt)) this.err(`unknown type '${pt}' in variant '${v.name}'`);
    for (const it of p.items) if (it.kind === "FnDecl") {
      if (this.fns.has(it.name)) this.err(`duplicate function '${it.name}'`);
      this.fns.set(it.name, { params: it.params, retTy: it.retTy });
      for (const pa of it.params) if (!this.typeKnown(pa.ty)) this.err(`unknown type '${pa.ty}' for parameter '${pa.name}'`);
      if (it.retTy && !this.typeKnown(it.retTy)) this.err(`unknown return type '${it.retTy}' for '${it.name}'`);
    }
    if (!this.fns.has("main")) this.err("no `main` function");
    const main = this.fns.get("main");
    if (main && (main.params.length > 0 || main.retTy)) this.err("`main` must take no parameters and declare no return type");
    for (const it of p.items) if (it.kind === "FnDecl") {
      this.push();
      this.curRet = it.retTy ?? "unit";
      for (const pa of it.params) this.define(pa.name, pa.ty);
      for (const s of it.body) this.checkStmt(s);
      this.pop();
    }
  }
  checkBlock(stmts: Stmt[]) { this.push(); for (const s of stmts) this.checkStmt(s); this.pop(); }

  checkStmt(s: Stmt) {
    switch (s.kind) {
      case "Let": {
        const vt = this.checkExpr(s.value);
        let declTy: string;
        if (s.annot) {
          if (!this.typeKnown(s.annot)) { this.err(`unknown type '${s.annot}'`); declTy = "i32"; }
          else if (!this.assignable(vt, s.annot)) { this.err(`type mismatch: cannot init '${s.name}: ${s.annot}' with ${vt}`); declTy = s.annot; }
          else declTy = s.annot;
        } else {
          declTy = vt === "intlit" ? "i32" : (vt === "floatlit" ? "f64" : vt);
          if (declTy === "str-iter" || declTy === "unit" || declTy === "unknown") { this.err(`cannot bind '${s.name}' to ${vt}`); declTy = "i32"; }
        }
        s.declTy = declTy;
        this.define(s.name, declTy);
        break;
      }
      case "Assign": {
        const tt = this.lookup(s.name);
        if (!tt) { this.err(`assign to undefined variable '${s.name}'`); this.checkExpr(s.value); break; }
        const vt = this.checkExpr(s.value);
        if (!this.assignable(vt, tt)) this.err(`type mismatch: cannot assign ${vt} to '${s.name}: ${tt}'`);
        break;
      }
      case "While": {
        if (this.checkExpr(s.cond) !== "bool") this.err("`while` condition must be bool");
        this.checkBlock(s.body);
        break;
      }
      case "If": {
        if (this.checkExpr(s.cond) !== "bool") this.err("`if` condition must be bool");
        this.checkBlock(s.then);
        if (s.els) this.checkBlock(s.els);
        break;
      }
      case "Match": {
        const st = this.checkExpr(s.scrut);
        const variants = this.enums.get(st);
        if (!variants) { this.err(`match on non-enum type ${st}`); for (const arm of s.arms) this.checkBlock(arm.body); break; }
        const covered = new Set<string>();
        let hasWild = false;
        for (const arm of s.arms) {
          if (arm.variant === "_") { hasWild = true; this.checkBlock(arm.body); continue; }
          const payload = variants.get(arm.variant);
          if (!payload) { this.err(`'${arm.variant}' is not a variant of ${st}`); this.checkBlock(arm.body); continue; }
          if (arm.bindings.length !== payload.length) this.err(`pattern '${arm.variant}' expects ${payload.length} binding(s), got ${arm.bindings.length}`);
          covered.add(arm.variant);
          this.push();
          arm.bindings.forEach((b, i) => this.define(b, payload[i] ?? "i32"));
          for (const st2 of arm.body) this.checkStmt(st2);
          this.pop();
        }
        if (!hasWild) for (const vn of variants.keys()) if (!covered.has(vn)) this.err(`non-exhaustive match: missing variant '${vn}'`);
        break;
      }
      case "ForOf": {
        if (!isStdinLines(s.iter)) this.err("M0: only `stdin.lines()` is iterable");
        this.push();
        this.define(s.binder, "str");
        for (const st of s.body) this.checkStmt(st);
        this.pop();
        break;
      }
      case "Return": {
        if (this.curRet === "unit") { if (s.value) this.err("cannot return a value from a function with no return type"); }
        else if (!s.value) this.err(`must return a ${this.curRet}`);
        else { const vt = this.checkExpr(s.value); if (!this.assignable(vt, this.curRet)) this.err(`return type mismatch: ${vt} vs ${this.curRet}`); }
        break;
      }
      case "Break": case "Continue": break;
      case "ExprStmt": { this.checkExpr(s.expr); break; }
    }
  }
  assignable(vt: string, tt: string): boolean {
    if (isInt(vt) && isInt(tt)) return unifyInt(vt, tt) !== null;
    if (isFloat(vt) && isFloat(tt)) return unifyFloat(vt, tt) !== null;
    return vt === tt;
  }
  checkExpr(e: Expr): string {
    switch (e.kind) {
      case "Num": e.ty = "intlit"; return e.ty;
      case "Float": e.ty = "floatlit"; return e.ty;
      case "Str": e.ty = "str"; return e.ty;
      case "Ident": {
        const t = this.lookup(e.name);
        if (t) { e.ty = t; return t; }
        const v = this.variants.get(e.name);
        if (v && v.payload.length === 0) { e.ty = v.enumName; return e.ty; }
        this.err(`undefined variable '${e.name}'`); e.ty = "i32"; return e.ty;
      }
      case "Member": {
        const ot = this.checkExpr(e.obj);
        const fm = this.structs.get(ot);
        if (fm) {
          const ft = fm.get(e.prop);
          if (ft) { e.ty = ft; return ft; }
          this.err(`no field '${e.prop}' on ${ot}`); e.ty = "i32"; return e.ty;
        }
        e.ty = "unknown"; return e.ty;
      }
      case "StructLit": {
        const fm = this.structs.get(e.name);
        if (!fm) { this.err(`unknown struct '${e.name}'`); e.ty = "i32"; return e.ty; }
        const seen = new Set<string>();
        for (const fld of e.fields) {
          const ft = fm.get(fld.name);
          const vt = this.checkExpr(fld.value);
          if (!ft) { this.err(`no field '${fld.name}' on ${e.name}`); continue; }
          seen.add(fld.name);
          if (!this.assignable(vt, ft)) this.err(`field '${e.name}.${fld.name}': cannot assign ${vt} to ${ft}`);
        }
        for (const fname of fm.keys()) if (!seen.has(fname)) this.err(`missing field '${fname}' in ${e.name} literal`);
        e.ty = e.name; return e.ty;
      }
      case "Call": {
        if (e.callee.kind === "Ident") {
          const sig = this.fns.get(e.callee.name);
          if (sig) {
            if (e.args.length !== sig.params.length) this.err(`'${e.callee.name}' expects ${sig.params.length} arg(s), got ${e.args.length}`);
            for (let k = 0; k < e.args.length; k++) {
              const at = this.checkExpr(e.args[k]);
              const p = sig.params[k];
              if (p && !this.assignable(at, p.ty)) this.err(`arg ${k + 1} of '${e.callee.name}': cannot pass ${at} as ${p.ty}`);
            }
            e.ty = sig.retTy ?? "unit";
            return e.ty;
          }
          const v = this.variants.get(e.callee.name);
          if (v) {
            if (e.args.length !== v.payload.length) this.err(`variant '${e.callee.name}' expects ${v.payload.length} payload(s), got ${e.args.length}`);
            for (let k = 0; k < e.args.length; k++) {
              const at = this.checkExpr(e.args[k]);
              const pt = v.payload[k];
              if (pt && !this.assignable(at, pt)) this.err(`payload ${k + 1} of '${e.callee.name}': cannot pass ${at} as ${pt}`);
            }
            e.ty = v.enumName; return e.ty;
          }
        }
        if (e.callee.kind === "Member" && e.callee.obj.kind === "Ident") {
          const recv = e.callee.obj.name, m = e.callee.prop;
          if (recv === "stdin" && m === "lines") { e.ty = "str-iter"; return e.ty; }
          if (recv === "stdout" && m === "println") {
            const at = e.args.length === 1 ? this.checkExpr(e.args[0]) : "unit";
            if (!(at === "str" || at === "bool" || isInt(at) || isFloat(at))) this.err(`stdout.println: cannot print ${at}`);
            e.ty = "unit"; return e.ty;
          }
        }
        this.err("M0: unsupported call"); e.ty = "unit"; return e.ty;
      }
      case "Binary": {
        const lt = this.checkExpr(e.left), rt = this.checkExpr(e.right);
        if (ARITH_OPS.includes(e.op)) {
          const intOnly = e.op.length === 2 || e.op === "%";   // %, +%, -%, *%, +|, -|, *|
          if ((isFloat(lt) || isFloat(rt)) && !intOnly) {
            const u = unifyFloat(lt, rt);
            if (u === null) { this.err(`'${e.op}' requires matching numeric types (got ${lt}, ${rt})`); e.ty = "f64"; }
            else e.ty = u;
          } else {
            if (isFloat(lt) || isFloat(rt)) this.err(`'${e.op}' is integer-only (got ${lt}, ${rt})`);
            const u = unifyInt(lt, rt);
            if (u === null) { this.err(`'${e.op}' requires matching integer types (got ${lt}, ${rt})`); e.ty = "i32"; }
            else e.ty = u;
          }
          return e.ty;
        }
        if (e.op === "==" || e.op === "!=") {
          if (isInt(lt) && isInt(rt)) { if (unifyInt(lt, rt) === null) this.err(`cannot compare ${lt} and ${rt}`); }
          else if (isFloat(lt) && isFloat(rt)) { if (unifyFloat(lt, rt) === null) this.err(`cannot compare ${lt} and ${rt}`); }
          else if (!((lt === "str" && rt === "str") || (lt === "bool" && rt === "bool"))) this.err(`cannot compare ${lt} and ${rt}`);
          e.ty = "bool"; return e.ty;
        }
        const okOrd = (isInt(lt) && isInt(rt) && unifyInt(lt, rt) !== null) || (isFloat(lt) && isFloat(rt) && unifyFloat(lt, rt) !== null);
        if (!okOrd) this.err(`'${e.op}' requires matching numeric types (got ${lt}, ${rt})`);
        e.ty = "bool"; return e.ty;
      }
    }
  }
}

function check(prog: Program): string[] {
  const c = new Checker();
  c.checkProgram(prog);
  return c.errs;
}

// ---------- Emit C++ ----------
let STRUCT_FIELDS = new Map<string, string[]>();
let VARIANTS = new Map<string, VarInfo>();
let matchCounter = 0;

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

function emitExpr(e: Expr): string {
  switch (e.kind) {
    case "Num": return e.value;
    case "Float": return e.value;
    case "Str": return cstr(e.value);
    case "Ident": {
      const v = VARIANTS.get(e.name);
      if (v && v.payload.length === 0) return `${v.enumName}{ .tag = ${v.index} }`;
      return e.name;
    }
    case "Member": return `${emitExpr(e.obj)}.${e.prop}`;
    case "StructLit": {
      const order = STRUCT_FIELDS.get(e.name) ?? e.fields.map((f) => f.name);
      const byName = new Map(e.fields.map((f) => [f.name, f.value]));
      const vals = order.map((fn) => { const v = byName.get(fn); return v ? emitExpr(v) : "{}"; });
      return `${e.name}{ ${vals.join(", ")} }`;
    }
    case "Binary": {
      const l = emitExpr(e.left), r = emitExpr(e.right);
      if (e.op === "==") return e.left.ty === "str" ? `mz::eq(${l}, ${r})` : `(${l} == ${r})`;
      if (e.op === "!=") return e.left.ty === "str" ? `(!mz::eq(${l}, ${r}))` : `(${l} != ${r})`;
      const fn = ARITH_FN[e.op];
      if (fn && isInt(e.ty ?? "")) return `mz::${fn}<${cppType(e.ty!)}>(${l}, ${r})`;  // overflow-aware integer arithmetic
      return `(${l} ${e.op} ${r})`;                                                    // float arithmetic + comparisons
    }
    case "Call": {
      if (e.callee.kind === "Ident") {
        const name = e.callee.name;
        const v = VARIANTS.get(name);
        if (v) {
          const parts = [`.tag = ${v.index}`, ...e.args.map((a, i) => `.${name}_${i} = ${emitExpr(a)}`)];
          return `${v.enumName}{ ${parts.join(", ")} }`;
        }
      }
      if (e.callee.kind === "Member" && e.callee.obj.kind === "Ident") {
        const recv = e.callee.obj.name, m = e.callee.prop;
        if (recv === "stdin" && m === "lines") return `mz::stdin_lines()`;
        if (recv === "stdout" && m === "println") {
          const a = e.args[0];
          const at = a.ty ?? "unit";
          if (at === "str" || at === "bool") return `mz::println(${emitExpr(a)})`;
          if (isInt(at)) return `mz::println((${isUnsigned(at) ? "unsigned long long" : "long long"})(${emitExpr(a)}))`;
          if (isFloat(at)) return `mz::println((double)(${emitExpr(a)}))`;
          return `mz::println(${emitExpr(a)})`;
        }
      }
      return `${emitExpr(e.callee)}(${e.args.map(emitExpr).join(", ")})`;
    }
  }
}

function emitMatch(s: Extract<Stmt, { kind: "Match" }>, ind: string, ctx: string): string {
  const tmp = `_m${matchCounter++}`;
  let out = `${ind}{ auto ${tmp} = ${emitExpr(s.scrut)};\n${ind}  switch (${tmp}.tag) {\n`;
  for (const arm of s.arms) {
    const body = arm.body.map((st) => emitStmt(st, ind + "    ", ctx)).join("\n");
    if (arm.variant === "_") {
      out += `${ind}  default: {\n${body}\n${ind}  break; }\n`;
    } else {
      const v = VARIANTS.get(arm.variant)!;
      const binds = arm.bindings.map((b, i) => `${ind}    ${cppType(v.payload[i])} ${b} = ${tmp}.${arm.variant}_${i};`).join("\n");
      out += `${ind}  case ${v.index}: {\n${binds ? binds + "\n" : ""}${body}\n${ind}  break; }\n`;
    }
  }
  out += `${ind}  }\n${ind}}`;
  return out;
}

function emitStmt(s: Stmt, ind: string, ctx: string): string {
  switch (s.kind) {
    case "Let": return `${ind}${cppType(s.declTy!)} ${s.name} = ${emitExpr(s.value)};`;
    case "Assign": return `${ind}${s.name} = ${emitExpr(s.value)};`;
    case "While": {
      const body = s.body.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n");
      return `${ind}while (${emitExpr(s.cond)}) {\n${body}\n${ind}}`;
    }
    case "ForOf": {
      const body = s.body.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n");
      return `${ind}for (mz::String ${s.binder} : mz::stdin_lines()) {\n${body}\n${ind}}`;
    }
    case "If": {
      const then = s.then.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n");
      let out = `${ind}if (${emitExpr(s.cond)}) {\n${then}\n${ind}}`;
      if (s.els) out += ` else {\n${s.els.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n")}\n${ind}}`;
      return out;
    }
    case "Match": return emitMatch(s, ind, ctx);
    case "Return":
      if (ctx === "main") return `${ind}return 0;`;
      return s.value ? `${ind}return ${emitExpr(s.value)};` : `${ind}return;`;
    case "Break": return `${ind}break;`;
    case "Continue": return `${ind}continue;`;
    case "ExprStmt": return `${ind}${emitExpr(s.expr)};`;
  }
}

function emitFn(fn: FnDecl): string {
  const body = fn.body.map((s) => emitStmt(s, "  ", fn.name === "main" ? "main" : (fn.retTy ? "value" : "void"))).join("\n");
  if (fn.name === "main") return `int main() {\n${body}\n  return 0;\n}`;
  const ret = fn.retTy ? cppType(fn.retTy) : "void";
  const params = fn.params.map((p) => `${cppType(p.ty)} ${p.name}`).join(", ");
  return `${ret} ${fn.name}(${params}) {\n${body}\n}`;
}

function emitTypeDecl(it: StructDecl | EnumDecl): string {
  if (it.kind === "StructDecl") return `struct ${it.name} { ${it.fields.map((f) => `${cppType(f.ty)} ${f.name};`).join(" ")} };`;
  const fields: string[] = ["int tag;"];
  for (const v of it.variants) v.payload.forEach((pt, i) => fields.push(`${cppType(pt)} ${v.name}_${i};`));
  return `struct ${it.name} { ${fields.join(" ")} };`;
}

function emit(prog: Program): string {
  const types = prog.items.filter((it): it is StructDecl | EnumDecl => it.kind === "StructDecl" || it.kind === "EnumDecl");
  const fns = prog.items.filter((it): it is FnDecl => it.kind === "FnDecl");

  STRUCT_FIELDS = new Map();
  VARIANTS = new Map();
  matchCounter = 0;
  for (const it of types) {
    if (it.kind === "StructDecl") STRUCT_FIELDS.set(it.name, it.fields.map((f) => f.name));
    else it.variants.forEach((v, idx) => VARIANTS.set(v.name, { enumName: it.name, index: idx, payload: v.payload }));
  }

  const typeDecls = types.map(emitTypeDecl).join("\n");
  const protos = fns
    .filter((f) => f.name !== "main")
    .map((f) => `${f.retTy ? cppType(f.retTy) : "void"} ${f.name}(${f.params.map((p) => cppType(p.ty)).join(", ")});`)
    .join("\n");
  const defs = fns.map(emitFn).join("\n\n");
  return `// generated by mozaic (M0)
#include "mozaic_rt.h"

${typeDecls ? typeDecls + "\n\n" : ""}${protos ? protos + "\n\n" : ""}${defs}
`;
}

// ---------- Driver ----------
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
  if (release) flags.push("-DMZ_RELEASE");      // release: integer overflow wraps; debug (default): traps
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
