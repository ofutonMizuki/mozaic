// Semantic analysis: name resolution + strict type checking.
import type { Program, Stmt, Expr, Param, Sig, VarInfo } from "./ast.ts";
import {
  BUILTIN_TYPES, ARITH_OPS, isInt, isFloat, unifyInt, unifyFloat, bufferElem, isStdinLines, isBufferNew,
} from "./ast.ts";

class Checker {
  errs: string[] = [];
  scopes: Map<string, string>[] = [];
  fns = new Map<string, Sig>();
  kernels = new Map<string, Param[]>();
  structs = new Map<string, Map<string, string>>();
  enums = new Map<string, Map<string, string[]>>();
  variants = new Map<string, VarInfo>();
  curRet = "unit";
  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }
  define(n: string, t: string) { this.scopes[this.scopes.length - 1].set(n, t); }
  lookup(n: string): string | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const t = this.scopes[i].get(n); if (t) return t; }
    return null;
  }
  err(m: string) { this.errs.push(m); }
  typeKnown(t: string): boolean {
    if (BUILTIN_TYPES.has(t) || this.structs.has(t) || this.enums.has(t)) return true;
    const be = bufferElem(t);
    return be !== null && this.typeKnown(be);
  }

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
    for (const it of p.items) if (it.kind === "KernelDecl") {
      if (this.kernels.has(it.name)) this.err(`duplicate kernel '${it.name}'`);
      this.kernels.set(it.name, it.params);
      for (const pa of it.params) if (!this.typeKnown(pa.ty)) this.err(`unknown type '${pa.ty}' for kernel param '${pa.name}'`);
    }
    for (const it of p.items) if (it.kind === "FnDecl") {
      if (this.fns.has(it.name)) this.err(`duplicate function '${it.name}'`);
      this.fns.set(it.name, { params: it.params, retTy: it.retTy });
      for (const pa of it.params) if (!this.typeKnown(pa.ty)) this.err(`unknown type '${pa.ty}' for parameter '${pa.name}'`);
      if (it.retTy && !this.typeKnown(it.retTy)) this.err(`unknown return type '${it.retTy}' for '${it.name}'`);
    }
    if (!this.fns.has("main")) this.err("no `main` function");
    const main = this.fns.get("main");
    if (main && (main.params.length > 0 || main.retTy)) this.err("`main` must take no parameters and declare no return type");
    for (const it of p.items) if (it.kind === "FnDecl" || it.kind === "KernelDecl") {
      this.push();
      this.curRet = (it.kind === "FnDecl" ? it.retTy : null) ?? "unit";
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
          if (vt === "buffernew") { this.err(`'${s.name}': Buffer.shared needs a type annotation (e.g. : Buffer<f32>)`); declTy = "i32"; }
          else { declTy = vt === "intlit" ? "i32" : (vt === "floatlit" ? "f64" : vt);
            if (declTy === "str-iter" || declTy === "unit" || declTy === "unknown") { this.err(`cannot bind '${s.name}' to ${vt}`); declTy = "i32"; } }
        }
        s.declTy = declTy;
        this.define(s.name, declTy);
        break;
      }
      case "Assign": {
        const tt = this.checkExpr(s.target);
        const vt = this.checkExpr(s.value);
        if (!this.assignable(vt, tt)) this.err(`type mismatch: cannot assign ${vt} to ${tt}`);
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
    if (vt === "buffernew" && bufferElem(tt) !== null) return true;
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
        if (e.obj.kind === "Ident" && e.obj.name === "grid" && (e.prop === "x" || e.prop === "y" || e.prop === "z")) { e.ty = "u32"; return e.ty; }
        const ot = this.checkExpr(e.obj);
        if (bufferElem(ot) !== null && e.prop === "len") { e.ty = "u32"; return e.ty; }
        const fm = this.structs.get(ot);
        if (fm) {
          const ft = fm.get(e.prop);
          if (ft) { e.ty = ft; return ft; }
          this.err(`no field '${e.prop}' on ${ot}`); e.ty = "i32"; return e.ty;
        }
        e.ty = "unknown"; return e.ty;
      }
      case "Index": {
        const ot = this.checkExpr(e.obj);
        const be = bufferElem(ot);
        if (be === null) { this.err(`cannot index ${ot}`); e.ty = "i32"; return e.ty; }
        const it = this.checkExpr(e.index);
        if (!isInt(it)) this.err(`buffer index must be an integer (got ${it})`);
        e.ty = be; return be;
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
        if (e.callee.kind === "Ident" && e.callee.name === "launch") {
          if (e.args.length < 2) this.err("launch needs (kernel, grid, ...args)");
          else {
            const kn = e.args[0];
            if (kn.kind !== "Ident" || !this.kernels.has(kn.name)) this.err("launch: first argument must be a kernel name");
            else {
              const kparams = this.kernels.get(kn.name)!;
              if (!isInt(this.checkExpr(e.args[1]))) this.err("launch: grid size must be an integer");
              const passed = e.args.slice(2);
              if (passed.length !== kparams.length) this.err(`launch '${kn.name}': expected ${kparams.length} kernel arg(s), got ${passed.length}`);
              for (let k = 0; k < passed.length; k++) {
                const at = this.checkExpr(passed[k]);
                const pt = kparams[k]?.ty;
                if (pt && !this.assignable(at, pt)) this.err(`launch arg ${k + 1}: cannot pass ${at} as ${pt}`);
              }
            }
          }
          e.ty = "unit"; return e.ty;
        }
        if (isBufferNew(e)) {
          if (e.args.length === 1) { if (!isInt(this.checkExpr(e.args[0]))) this.err("Buffer.shared(n): n must be an integer"); }
          else this.err("Buffer.shared takes one argument");
          e.ty = "buffernew"; return e.ty;
        }
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
          const intOnly = e.op.length === 2 || e.op === "%";
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

export function check(prog: Program): string[] {
  const c = new Checker();
  c.checkProgram(prog);
  return c.errs;
}
