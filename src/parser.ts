// Recursive-descent parser: tokens -> AST.
import type {
  Program, Item, Param, Field, Variant, StructDecl, EnumDecl, FnDecl, KernelDecl, Method, Arm, Stmt, Expr,
} from "./ast.ts";
import type { Tok } from "./lexer.ts";

export class Parser {
  toks: Tok[];
  i: number;
  noStruct = false;
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
  parseType(): string {
    let t = this.parseTypeCore();
    while (this.at("?")) { this.next(); t = t + "?"; }   // trailing ? -> optional (binds tighter than &)
    return t;
  }
  parseTypeCore(): string {
    if (this.at("&")) {   // reference type: &T (shared) / &mut T (exclusive)
      this.next();
      let mut = false;
      if (this.at("mut")) { this.next(); mut = true; }
      return (mut ? "&mut " : "&") + this.parseType();
    }
    const name = this.eat("id").v;
    if (this.at("<")) {   // generic args: Buffer<T> (1) / Result<T, E> (2)
      this.next();
      const args = [this.parseType()];
      while (this.at(",")) { this.next(); args.push(this.parseType()); }
      this.eat(">");
      return `${name}<${args.join(", ")}>`;
    }
    return name;
  }
  parseProgram(): Program {
    const items: Item[] = [];
    while (!this.at("eof")) {
      if (this.at("struct")) items.push(this.parseStruct());
      else if (this.at("enum")) items.push(this.parseEnum());
      else if (this.at("kernel")) items.push(this.parseKernel());
      else items.push(this.parseFn());
    }
    return { kind: "Program", items };
  }
  parseStruct(): StructDecl {
    this.eat("struct");
    const name = this.eat("id").v;
    this.eat("{");
    const fields: Field[] = [];
    const methods: Method[] = [];
    while (!this.at("}")) {
      if (this.at("function")) { methods.push(this.parseMethod()); continue; }
      const fname = this.eat("id").v;
      this.eat(":");
      const ty = this.parseType();
      this.eat(";");
      fields.push({ name: fname, ty });
    }
    this.eat("}");
    return { kind: "StructDecl", name, fields, methods };
  }
  parseMethod(): Method {
    this.eat("function");
    const name = this.eat("id").v;
    this.eat("(");
    let recv: "self" | "&self" | "&mut self" = "self";
    if (this.at("&")) { this.next(); if (this.at("mut")) { this.next(); recv = "&mut self"; } else recv = "&self"; }
    if (this.eat("id").v !== "self") throw new Error("parse error: method receiver must be self / &self / &mut self");
    const params: Param[] = [];
    while (this.at(",")) { this.next(); params.push(this.parseParam()); }
    this.eat(")");
    let retTy: string | null = null;
    if (this.at(":")) { this.next(); retTy = this.parseType(); }
    return { name, recv, params, retTy, body: this.parseBlock() };
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
        if (!this.at(")")) { payload.push(this.parseType()); while (this.at(",")) { this.next(); payload.push(this.parseType()); } }
        this.eat(")");
      }
      variants.push({ name: vn, payload });
      if (this.at(",")) this.next(); else break;
    }
    this.eat("}");
    return { kind: "EnumDecl", name, variants };
  }
  parseParam(): Param {
    const name = this.eat("id").v;
    this.eat(":");
    return { name, ty: this.parseType() };
  }
  parseParams(): Param[] {
    const params: Param[] = [];
    this.eat("(");
    if (!this.at(")")) { params.push(this.parseParam()); while (this.at(",")) { this.next(); params.push(this.parseParam()); } }
    this.eat(")");
    return params;
  }
  parseFn(): FnDecl {
    this.eat("function");
    const name = this.eat("id").v;
    const params = this.parseParams();
    let retTy: string | null = null;
    if (this.at(":")) { this.next(); retTy = this.parseType(); }
    return { kind: "FnDecl", name, params, retTy, body: this.parseBlock() };
  }
  parseKernel(): KernelDecl {
    this.eat("kernel");
    const name = this.eat("id").v;
    const params = this.parseParams();
    return { kind: "KernelDecl", name, params, body: this.parseBlock() };
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
    if (t === "scope") return this.parseScope();
    if (t === "defer") return this.parseDefer();
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
      if (e.kind !== "Ident" && e.kind !== "Index" && e.kind !== "Member") throw new Error("parse error: invalid assignment target");
      return { kind: "Assign", target: e, value };
    }
    this.eat(";");
    return { kind: "ExprStmt", expr: e };
  }
  parseLet(): Stmt {
    const isConst = this.next().t === "const";
    const name = this.eat("id").v;
    let annot: string | null = null;
    if (this.at(":")) { this.next(); annot = this.parseType(); }
    this.eat("=");
    const value = this.parseExpr();
    this.eat(";");
    return { kind: "Let", name, annot, value, isConst };
  }
  parseWhile(): Stmt {
    this.eat("while"); this.eat("(");
    const cond = this.parseExpr();
    this.eat(")");
    return { kind: "While", cond, body: this.parseBlock() };
  }
  parseScope(): Stmt {
    this.eat("scope");
    return { kind: "Scope", body: this.parseBlock() };
  }
  parseDefer(): Stmt {   // `defer <stmt>` or `defer { ... }`
    this.eat("defer");
    return { kind: "Defer", body: this.at("{") ? this.parseBlock() : [this.parseStmt()] };
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
  parseExpr(): Expr { return this.parseOrElse(); }
  parseOrElse(): Expr {   // `a ?? b` (unwrap-or) — loosest binary; right side is a comparison
    let left = this.parseComparison();
    while (this.at("??")) { this.next(); left = { kind: "OrElse", opt: left, alt: this.parseComparison() }; }
    return left;
  }
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
    let left = this.parseCast();
    while (this.at("*") || this.at("/") || this.at("%") || this.at("*%") || this.at("*|")) {
      const op = this.next().t;
      left = { kind: "Binary", op, left, right: this.parseCast() };
    }
    return left;
  }
  parseCast(): Expr {   // `e as T` / `e as? T` — the only (explicit) conversion; binds tighter than * /
    let e = this.parseUnary();
    while (this.at("as")) {
      this.next();
      let opt = false;
      if (this.at("?")) { this.next(); opt = true; }
      e = { kind: "Cast", expr: e, toTy: this.parseType(), opt };
    }
    return e;
  }
  parseUnary(): Expr {
    if (this.at("&")) {
      this.next();
      let mut = false;
      if (this.at("mut")) { this.next(); mut = true; }
      return { kind: "Borrow", mut, expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }
  parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at(".")) { this.next(); e = { kind: "Member", obj: e, prop: this.eat("id").v }; }
      else if (this.at("?")) { this.next(); e = { kind: "Try", expr: e }; }   // postfix ? -> propagate none
      else if (this.at("[")) { this.next(); const index = this.parseExpr(); this.eat("]"); e = { kind: "Index", obj: e, index }; }
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
    if (tk.t === "spawn") {
      this.next();
      const call = this.parsePostfix();   // spawn f(args...) — launch-shaped: function + args, no closure
      if (call.kind !== "Call") throw new Error(`parse error: 'spawn' requires a function call at ${tk.pos}`);
      return { kind: "SpawnExpr", call };
    }
    if (tk.t === "num") { this.next(); return { kind: "Num", value: tk.v }; }
    if (tk.t === "fnum") { this.next(); return { kind: "Float", value: tk.v }; }
    if (tk.t === "str") { this.next(); return { kind: "Str", value: tk.v }; }
    if (tk.t === "char") { this.next(); return { kind: "Char", value: tk.v }; }
    if (tk.t === "true" || tk.t === "false") { this.next(); return { kind: "Bool", value: tk.t === "true" }; }
    if (tk.t === "none") { this.next(); return { kind: "None" }; }
    if (tk.t === "some") { this.next(); this.eat("("); const inner = this.parseExpr(); this.eat(")"); return { kind: "Some", expr: inner }; }
    // built-in Result constructors: only `Ok(` / `Err(` (a bare Ok/Err stays an ordinary ident)
    if (tk.t === "id" && (tk.v === "Ok" || tk.v === "Err") && this.toks[this.i + 1]?.t === "(") {
      this.next(); this.eat("(");
      const inner = this.parseExpr();
      this.eat(")");
      return { kind: tk.v === "Ok" ? "Ok" : "Err", expr: inner };
    }
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
