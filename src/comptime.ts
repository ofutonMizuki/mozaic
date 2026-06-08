// Compile-time evaluation (`comptime e` and top-level `const`).
// A small tree-walking interpreter over the typed AST. It runs pure mozaic code at build
// time and yields a CTValue, which emit.ts renders as a C++ initializer. This is the honest
// model of comptime (the compiler executes the code) — it keeps the C++ codegen free of
// constexpr fragility. Supported subset: literals, arithmetic/compare/logical, casts, arrays,
// fixed-array/string indexing & .len, struct literals & field access, user-function calls,
// and the imperative core (let / assign / if / while / return / break / continue).
import type { Program, Stmt, Expr, FnDecl, CTValue } from "./ast.ts";
import { isInt, isFloat, arrayParts } from "./ast.ts";

class ReturnSignal { value: CTValue | null; constructor(value: CTValue | null) { this.value = value; } }
class BreakSignal {}
class ContinueSignal {}

const WIDTH: Record<string, number> = {
  i8: 8, i16: 16, i32: 32, i64: 64, i128: 128, u8: 8, u16: 16, u32: 32, u64: 64, u128: 128, intlit: 32,
};
function isU(ty: string): boolean { return ty.startsWith("u"); }
function intRange(ty: string): [bigint, bigint] {
  const w = BigInt(WIDTH[ty] ?? 32);
  return isU(ty) ? [0n, (1n << w) - 1n] : [-(1n << (w - 1n)), (1n << (w - 1n)) - 1n];
}
// Two's-complement wrap of `v` into `ty` (used by +%/-%/*% and by `as` narrowing).
function wrapInt(v: bigint, ty: string): bigint {
  const w = BigInt(WIDTH[ty] ?? 32);
  const mask = (1n << w) - 1n;
  let r = v & mask;
  if (!isU(ty) && (r >> (w - 1n)) & 1n) r -= (1n << w);   // sign-extend
  return r;
}

export class CompileError extends Error {}

export class Comptime {
  fns = new Map<string, FnDecl>();
  consts = new Map<string, CTValue>();
  steps = 0;
  constructor(prog: Program) {
    for (const it of prog.items) if (it.kind === "FnDecl") this.fns.set(it.name, it);
  }
  private tick() { if (++this.steps > 50_000_000) throw new CompileError("comptime evaluation exceeded the step limit (infinite loop?)"); }

  // Deep-copy a value so binding/assignment/return keep mozaic's value semantics (arrays are Copy).
  clone(v: CTValue): CTValue {
    if (v.k === "arr") return { k: "arr", elem: v.elem, v: v.v.map((x) => this.clone(x)) };
    if (v.k === "struct") { const f = new Map<string, CTValue>(); for (const [k, x] of v.fields) f.set(k, this.clone(x)); return { k: "struct", name: v.name, fields: f }; }
    return { ...v };
  }

  evalConst(value: Expr, ty: string): CTValue {
    const v = this.eval(value, [new Map()]);
    return this.coerce(v, ty);
  }
  // Adjust a literal-typed value to its declared type (intlit/floatlit pick up the target).
  coerce(v: CTValue, ty: string): CTValue {
    if (v.k === "int" && isInt(ty)) return v;
    if (v.k === "float" && isFloat(ty)) return v;
    if (v.k === "arr") { const ap = arrayParts(ty); if (ap) return { k: "arr", elem: ap[0], v: v.v.map((x) => this.coerce(x, ap[0])) }; }
    return v;
  }

  eval(e: Expr, env: Map<string, CTValue>[]): CTValue {
    this.tick();
    switch (e.kind) {
      case "Num": return { k: "int", v: BigInt(e.value) };
      case "Float": return { k: "float", v: Number(e.value) };
      case "Bool": return { k: "bool", v: e.value };
      case "Char": return { k: "char", v: Number(e.value) };
      case "Str": return { k: "str", v: e.value };
      case "Comptime": return this.eval(e.expr, env);
      case "Ident": {
        for (let i = env.length - 1; i >= 0; i--) { const f = env[i].get(e.name); if (f) return f; }
        const c = this.consts.get(e.name);
        if (c) return this.clone(c);
        throw new CompileError(`comptime: '${e.name}' is not a compile-time value`);
      }
      case "Array": {
        const elem = arrayParts(e.ty ?? "")?.[0] ?? "i32";
        return { k: "arr", elem, v: e.elems.map((x) => this.eval(x, env)) };
      }
      case "StructLit": {
        const fields = new Map<string, CTValue>();
        for (const f of e.fields) fields.set(f.name, this.eval(f.value, env));
        return { k: "struct", name: (e.ty ?? e.name), fields };
      }
      case "Index": {
        const obj = this.eval(e.obj, env);
        const idx = this.asInt(this.eval(e.index, env));
        if (obj.k === "arr") { const x = obj.v[Number(idx)]; if (!x) throw new CompileError(`comptime: index ${idx} out of bounds`); return x; }
        if (obj.k === "str") { const cp = [...obj.v][Number(idx)]; if (cp === undefined) throw new CompileError(`comptime: index ${idx} out of bounds`); return { k: "char", v: cp.codePointAt(0)! }; }
        throw new CompileError("comptime: cannot index this value");
      }
      case "Member": {
        if (e.prop === "len") {
          const obj = this.eval(e.obj, env);
          if (obj.k === "arr") return { k: "int", v: BigInt(obj.v.length) };
          if (obj.k === "str") return { k: "int", v: BigInt([...obj.v].length) };
        }
        const obj = this.eval(e.obj, env);
        if (obj.k === "struct") { const f = obj.fields.get(e.prop); if (f) return f; }
        throw new CompileError(`comptime: cannot read .${e.prop}`);
      }
      case "Cast": return this.cast(this.eval(e.expr, env), e.toTy, e.opt);
      case "Unary": {
        const v = this.eval(e.expr, env);
        if (e.op === "~") { if (v.k !== "int") throw new CompileError("comptime: '~' needs an integer"); const ty = e.ty && WIDTH[e.ty] ? e.ty : "i32"; return { k: "int", v: wrapInt(~v.v, ty) }; }
        if (v.k !== "bool") throw new CompileError("comptime: '!' needs a bool");
        return { k: "bool", v: !v.v };
      }
      case "Binary": return this.binary(e, env);
      case "Call": return this.call(e, env);
      default: throw new CompileError(`comptime: '${e.kind}' is not allowed in a compile-time expression`);
    }
  }

  private asInt(v: CTValue): bigint { if (v.k !== "int") throw new CompileError("comptime: expected an integer"); return v.v; }

  cast(v: CTValue, toTy: string, opt: boolean): CTValue {
    if (opt) throw new CompileError("comptime: 'as?' is not supported in a compile-time expression");
    const num = v.k === "int" ? v.v : v.k === "char" ? BigInt(v.v) : v.k === "bool" ? (v.v ? 1n : 0n) : null;
    if (toTy === "char") { const n = num ?? BigInt(Math.trunc((v as { v: number }).v)); return { k: "char", v: Number(wrapInt(n, "u32")) }; }
    if (isFloat(toTy)) return { k: "float", v: num !== null ? Number(num) : (v as { v: number }).v };
    if (isInt(toTy)) { const n = num !== null ? num : BigInt(Math.trunc((v as { v: number }).v)); return { k: "int", v: wrapInt(n, toTy) }; }
    throw new CompileError(`comptime: cannot cast to ${toTy}`);
  }

  binary(e: Extract<Expr, { kind: "Binary" }>, env: Map<string, CTValue>[]): CTValue {
    const op = e.op;
    if (op === "&&" || op === "||") {   // short-circuit logical
      const l = this.eval(e.left, env);
      if (l.k !== "bool") throw new CompileError("comptime: '&&'/'||' need bool");
      if (op === "&&" && !l.v) return { k: "bool", v: false };
      if (op === "||" && l.v) return { k: "bool", v: true };
      const r = this.eval(e.right, env);
      if (r.k !== "bool") throw new CompileError("comptime: '&&'/'||' need bool");
      return { k: "bool", v: r.v };
    }
    const l = this.eval(e.left, env), r = this.eval(e.right, env);
    if (op === "+" && l.k === "str" && r.k === "str") return { k: "str", v: l.v + r.v };
    if (op === "==" || op === "!=") { const eq = this.equalCT(l, r); return { k: "bool", v: op === "==" ? eq : !eq }; }
    // numeric arithmetic / ordering
    if (l.k === "float" || r.k === "float") {
      const a = this.asNum(l), b = this.asNum(r);
      switch (op) {
        case "+": return { k: "float", v: a + b }; case "-": return { k: "float", v: a - b };
        case "*": return { k: "float", v: a * b }; case "/": return { k: "float", v: a / b };
        case "<": return { k: "bool", v: a < b }; case "<=": return { k: "bool", v: a <= b };
        case ">": return { k: "bool", v: a > b }; case ">=": return { k: "bool", v: a >= b };
        default: throw new CompileError(`comptime: operator '${op}' not allowed on floats`);
      }
    }
    if (l.k === "char" && r.k === "char") {
      const a = l.v, b = r.v;
      switch (op) { case "<": return { k: "bool", v: a < b }; case "<=": return { k: "bool", v: a <= b }; case ">": return { k: "bool", v: a > b }; case ">=": return { k: "bool", v: a >= b }; }
    }
    const a = this.asInt(l), b = this.asInt(r);
    const ty = e.ty && WIDTH[e.ty] ? e.ty : "i32";
    switch (op) {
      case "<": return { k: "bool", v: a < b }; case "<=": return { k: "bool", v: a <= b };
      case ">": return { k: "bool", v: a > b }; case ">=": return { k: "bool", v: a >= b };
      case "+": return this.checked(a + b, ty); case "-": return this.checked(a - b, ty); case "*": return this.checked(a * b, ty);
      case "+%": return { k: "int", v: wrapInt(a + b, ty) }; case "-%": return { k: "int", v: wrapInt(a - b, ty) }; case "*%": return { k: "int", v: wrapInt(a * b, ty) };
      case "+|": return { k: "int", v: this.sat(a + b, ty) }; case "-|": return { k: "int", v: this.sat(a - b, ty) }; case "*|": return { k: "int", v: this.sat(a * b, ty) };
      case "/": { if (b === 0n) throw new CompileError("comptime: division by zero"); return this.checked(this.tdiv(a, b), ty); }
      case "%": { if (b === 0n) throw new CompileError("comptime: remainder by zero"); return { k: "int", v: a % b }; }
      case "&": return { k: "int", v: wrapInt(a & b, ty) };
      case "|": return { k: "int", v: wrapInt(a | b, ty) };
      case "^": return { k: "int", v: wrapInt(a ^ b, ty) };
      case "<<": case ">>": {
        const w = BigInt(WIDTH[ty] ?? 32);
        if (b < 0n || b >= w) throw new CompileError(`comptime: shift count ${b} out of range for ${ty}`);
        return { k: "int", v: wrapInt(op === "<<" ? a << b : a >> b, ty) };
      }
      default: throw new CompileError(`comptime: operator '${op}' not allowed`);
    }
  }
  private tdiv(a: bigint, b: bigint): bigint { return a / b; }   // bigint / truncates toward zero (like C++)
  private checked(v: bigint, ty: string): CTValue { const [lo, hi] = intRange(ty); if (v < lo || v > hi) throw new CompileError(`comptime: integer overflow (${v} out of range for ${ty})`); return { k: "int", v }; }
  private sat(v: bigint, ty: string): bigint { const [lo, hi] = intRange(ty); return v < lo ? lo : v > hi ? hi : v; }
  private asNum(v: CTValue): number { return v.k === "float" ? v.v : v.k === "int" ? Number(v.v) : v.k === "char" ? v.v : NaN; }
  private equalCT(l: CTValue, r: CTValue): boolean {
    if (l.k === "int" && r.k === "int") return l.v === r.v;
    if ((l.k === "float" || l.k === "int") && (r.k === "float" || r.k === "int")) return this.asNum(l) === this.asNum(r);
    if (l.k === "bool" && r.k === "bool") return l.v === r.v;
    if (l.k === "char" && r.k === "char") return l.v === r.v;
    if (l.k === "str" && r.k === "str") return l.v === r.v;
    return false;
  }

  call(e: Extract<Expr, { kind: "Call" }>, env: Map<string, CTValue>[]): CTValue {
    if (e.callee.kind !== "Ident") throw new CompileError("comptime: only calls to named functions are allowed");
    const fn = this.fns.get(e.callee.name);
    if (!fn) throw new CompileError(`comptime: '${e.callee.name}' is not a comptime-callable function`);
    if (fn.typeParams && fn.typeParams.length) throw new CompileError(`comptime: generic function '${e.callee.name}' is not supported`);
    const args = e.args.map((a) => this.clone(this.eval(a, env)));
    const scope = new Map<string, CTValue>();
    fn.params.forEach((p, i) => scope.set(p.name, this.coerce(args[i], p.ty)));
    try { this.execBlock(fn.body, [scope]); }
    catch (sig) { if (sig instanceof ReturnSignal) return sig.value !== null ? this.coerce(sig.value, fn.retTy ?? "i32") : { k: "int", v: 0n }; throw sig; }
    throw new CompileError(`comptime: '${e.callee.name}' returned no value`);
  }

  execBlock(stmts: Stmt[], env: Map<string, CTValue>[]) {
    env.push(new Map());
    try { for (const s of stmts) this.exec(s, env); }
    finally { env.pop(); }
  }
  exec(s: Stmt, env: Map<string, CTValue>[]) {
    this.tick();
    switch (s.kind) {
      case "Let": { const v = this.clone(this.eval(s.value, env)); env[env.length - 1].set(s.name, this.coerce(v, s.declTy ?? "i32")); break; }
      case "Assign": {
        const v = this.clone(this.eval(s.value, env));
        if (s.target.kind === "Ident") { const slot = this.findSlot(env, s.target.name); slot.set(s.target.name, this.coerce(v, slot.get(s.target.name)!.k === "int" ? "i32" : "f64")); break; }
        this.assignPath(s.target, v, env); break;
      }
      case "If": { const c = this.eval(s.cond, env); if (c.k !== "bool") throw new CompileError("comptime: if condition must be bool"); if (c.v) this.execBlock(s.then, env); else if (s.els) this.execBlock(s.els, env); break; }
      case "While": { for (;;) { this.tick(); const c = this.eval(s.cond, env); if (c.k !== "bool") throw new CompileError("comptime: while condition must be bool"); if (!c.v) break; try { this.execBlock(s.body, env); } catch (sig) { if (sig instanceof BreakSignal) break; if (sig instanceof ContinueSignal) continue; throw sig; } } break; }
      case "Return": throw new ReturnSignal(s.value ? this.eval(s.value, env) : null);
      case "Break": throw new BreakSignal();
      case "Continue": throw new ContinueSignal();
      case "ExprStmt": this.eval(s.expr, env); break;
      default: throw new CompileError(`comptime: statement '${s.kind}' is not supported`);
    }
  }
  private findSlot(env: Map<string, CTValue>[], name: string): Map<string, CTValue> {
    for (let i = env.length - 1; i >= 0; i--) if (env[i].has(name)) return env[i];
    throw new CompileError(`comptime: assignment to unknown '${name}'`);
  }
  // Assign through arr[i] / struct.field paths, mutating the existing value in place.
  private assignPath(target: Expr, v: CTValue, env: Map<string, CTValue>[]) {
    if (target.kind === "Index") {
      const obj = this.eval(target.obj, env);
      const i = Number(this.asInt(this.eval(target.index, env)));
      if (obj.k !== "arr") throw new CompileError("comptime: cannot index-assign a non-array");
      if (i < 0 || i >= obj.v.length) throw new CompileError(`comptime: index ${i} out of bounds`);
      obj.v[i] = this.coerce(v, obj.elem);
      return;
    }
    if (target.kind === "Member") {
      const obj = this.eval(target.obj, env);
      if (obj.k !== "struct") throw new CompileError("comptime: cannot field-assign a non-struct");
      obj.fields.set(target.prop, v);
      return;
    }
    throw new CompileError("comptime: unsupported assignment target");
  }
}
