// Code generation: typed AST -> C++ source.
import type { Program, Stmt, Expr, Param, StructDecl, EnumDecl, FnDecl, KernelDecl, Method, VarInfo } from "./ast.ts";
import { isInt, isUnsigned, isFloat, isCopy, bufferElem, atomicElem, containsAtomic, cppType, ARITH_FN, isBufferNew, isAtomicNew } from "./ast.ts";

let STRUCT_FIELDS = new Map<string, string[]>();
let STRUCT_FIELD_TYPES = new Map<string, string[]>();   // struct name -> field types (parallel to STRUCT_FIELDS)
let VARIANTS = new Map<string, VarInfo>();
let KERNELS = new Map<string, Param[]>();
let FN_PARAMS = new Map<string, Param[]>();              // fn name -> params (to decide std::ref in spawn)
let TARGET: "cpu" | "metal" = "cpu";
let matchCounter = 0;
let scopeCounter = 0;
const scopeVarStack: string[] = [];                      // current scope's std::thread vector name

// Memory orderings lower to std::memory_order_* (SPEC §5). A bare Ordering ident emits the constant.
const ORDER_CPP: Record<string, string> = {
  Relaxed: "std::memory_order_relaxed", Acquire: "std::memory_order_acquire",
  Release: "std::memory_order_release", AcqRel: "std::memory_order_acq_rel",
};
function hasAtomic(t: string): boolean { return containsAtomic(t, STRUCT_FIELD_TYPES); }
// spawn f(args): the fn name + each arg, wrapping by-reference params (Buffer / atomic-containing) in std::ref.
function spawnCallParts(call: Extract<Expr, { kind: "Call" }>): { fn: string; args: string[] } {
  const fn = (call.callee as Extract<Expr, { kind: "Ident" }>).name;
  const params = FN_PARAMS.get(fn) ?? [];
  const args = call.args.map((a, i) => {
    const p = params[i];
    const byRef = p && (bufferElem(p.ty) !== null || hasAtomic(p.ty));
    const code = emitExpr(a);   // &x / &mut x already lower to the underlying lvalue
    return byRef ? `std::ref(${code})` : code;
  });
  return { fn, args };
}

// ---- kernel argument binding layout (shared by the MSL emitter and the host launch) ----
// Params occupy MSL buffer indices 0..P-1 in declaration order (a Buffer<T> is a
// `device T*`, a scalar is a `constant T&`). MSL device pointers carry no length, so each
// Buffer param also gets a `<name>_len` uniform appended at indices P, P+1, ... — this map
// records those indices. Both sides derive the layout from the same param list, so they agree.
function kernelLenIndex(params: Param[]): Map<string, number> {
  const m = new Map<string, number>();
  let next = params.length;
  for (const p of params) if (bufferElem(p.ty) !== null) m.set(p.name, next++);
  return m;
}
// The launch grid lowers to an mz::Grid{x,y,z}. A bare integer is 1-D (y=z=1);
// grid2()/grid3() already emit an mz::Grid, so pass them through.
function gridExpr(g: Expr): string {
  if (g.ty === "Grid") return emitExpr(g);
  return `mz::Grid{ (uint32_t)(${emitExpr(g)}), 1, 1 }`;
}
// Host-side Metal binding for one launch: pipeline + buffer/scalar/length sets, in MSL index
// order. Shared by free launch (sync .run()) and dev.launch (async .commit() -> Job).
function metalBindLines(kn: string, grid: Expr, kargs: Expr[]): string[] {
  const params = KERNELS.get(kn)!;
  const lenIdx = kernelLenIndex(params);
  const lines = [
    `static mz::MetalKernel _mk("${kn}", _msl_${kn});`,
    `mz::MetalDispatch _d(_mk, ${gridExpr(grid)});`,
  ];
  params.forEach((p, i) => {
    if (bufferElem(p.ty) !== null) lines.push(`_d.buffer(${i}, ${emitExpr(kargs[i])});`);
    else lines.push(`_d.value<${cppType(p.ty)}>(${i}, (${cppType(p.ty)})(${emitExpr(kargs[i])}));`);
  });
  params.forEach((p, i) => {
    if (bufferElem(p.ty) !== null) lines.push(`_d.length(${lenIdx.get(p.name)}, ${emitExpr(kargs[i])});`);
  });
  return lines;
}

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
    case "Char": return `(char32_t)${e.value}`;
    case "Bool": return e.value ? "true" : "false";
    case "Cast": return `(${cppType(e.toTy)})(${emitExpr(e.expr)})`;   // explicit (possibly lossy) conversion
    case "Ident": {
      if (e.name === "self") return "(*this)";   // method receiver -> the C++ instance
      if (e.name in ORDER_CPP) return ORDER_CPP[e.name];
      const v = VARIANTS.get(e.name);
      if (v && v.payload.length === 0) return `${v.enumName}{ .tag = ${v.index} }`;
      return e.name;
    }
    case "Member":
      if (e.obj.kind === "Ident" && e.obj.name === "grid") return `grid_${e.prop}`;
      if (e.obj.kind === "Ident" && e.obj.name === "Device" && (e.prop === "gpu" || e.prop === "cpu")) return `mz::Device{}`;
      return `${emitExpr(e.obj)}.${e.prop}`;
    case "Borrow": return emitExpr(e.expr);   // a borrow lowers to the buffer itself
    case "Index": return `${emitExpr(e.obj)}[${emitExpr(e.index)}]`;
    case "SpawnExpr": throw new Error("spawn must be a statement, or `let t: Task = spawn f(...)`");
    case "StructLit": {
      const order = STRUCT_FIELDS.get(e.name) ?? e.fields.map((f) => f.name);
      const ftypes = STRUCT_FIELD_TYPES.get(e.name) ?? [];
      const byName = new Map(e.fields.map((f) => [f.name, f.value]));
      const vals = order.map((fn, i) => {
        const v = byName.get(fn);
        if (!v) return "{}";
        const ae = ftypes[i] ? atomicElem(ftypes[i]) : null;   // an Atomic field is brace-inited in place (non-movable)
        if (ae !== null && isAtomicNew(v)) return `std::atomic<${cppType(ae)}>{ ${emitExpr((v as Extract<Expr, { kind: "Call" }>).args[0])} }`;
        return emitExpr(v);
      });
      return `${e.name}{ ${vals.join(", ")} }`;
    }
    case "Binary": {
      const l = emitExpr(e.left), r = emitExpr(e.right);
      if (e.op === "==") return e.left.ty === "str" ? `mz::eq(${l}, ${r})` : `(${l} == ${r})`;
      if (e.op === "!=") return e.left.ty === "str" ? `(!mz::eq(${l}, ${r}))` : `(${l} != ${r})`;
      const fn = ARITH_FN[e.op];
      if (fn && isInt(e.ty ?? "")) return `mz::${fn}<${cppType(e.ty!)}>(${l}, ${r})`;
      return `(${l} ${e.op} ${r})`;
    }
    case "Call": {
      // free launch(kernel, grid, args...) — synchronous sugar (dispatch + wait inline)
      if (e.callee.kind === "Ident" && e.callee.name === "launch") {
        const kn = (e.args[0] as Extract<Expr, { kind: "Ident" }>).name;
        const grid = e.args[1];
        const kargs = e.args.slice(2);
        if (TARGET === "metal") return `([&]{ ${[...metalBindLines(kn, grid, kargs), "_d.run();"].join(" ")} }())`;
        const ka = kargs.map(emitExpr);
        return `mz::launch(${gridExpr(grid)}, [&](uint32_t grid_x, uint32_t grid_y, uint32_t grid_z){ ${kn}(grid_x, grid_y, grid_z${ka.length ? ", " + ka.join(", ") : ""}); })`;
      }
      // dev.launch(kernel, grid, &buf, &mut out, ...) — async; returns a Job to await later
      if (e.callee.kind === "Member" && e.callee.prop === "launch") {
        const kn = (e.args[0] as Extract<Expr, { kind: "Ident" }>).name;
        const grid = e.args[1];
        const kargs = e.args.slice(2);
        if (TARGET === "metal") return `([&]{ ${[...metalBindLines(kn, grid, kargs), "return _d.commit();"].join(" ")} }())`;
        const ka = kargs.map(emitExpr);
        return `([&]{ mz::launch(${gridExpr(grid)}, [&](uint32_t grid_x, uint32_t grid_y, uint32_t grid_z){ ${kn}(grid_x, grid_y, grid_z${ka.length ? ", " + ka.join(", ") : ""}); }); return mz::Job{}; }())`;
      }
      // grid2(w,h) / grid3(w,h,d) -> mz::Grid{...}
      if (e.callee.kind === "Ident" && (e.callee.name === "grid2" || e.callee.name === "grid3")) {
        const d = e.args.map((a) => `(uint32_t)(${emitExpr(a)})`);
        return `mz::Grid{ ${d.join(", ")}${e.callee.name === "grid2" ? ", 1" : ""} }`;
      }
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
        if (recv === "clock" && m === "now") return `mz::now_ns()`;
        if (recv === "stdin" && m === "lines") return `mz::stdin_lines()`;
        if (recv === "stdout" && m === "println") {
          const a = e.args[0];
          const at = a.ty ?? "unit";
          if (at === "str" || at === "bool") return `mz::println(${emitExpr(a)})`;
          if (at === "char") return `mz::println((char32_t)(${emitExpr(a)}))`;
          if (isInt(at)) return `mz::println((${isUnsigned(at) ? "unsigned long long" : "long long"})(${emitExpr(a)}))`;
          if (isFloat(at)) return `mz::println((double)(${emitExpr(a)}))`;
          return `mz::println(${emitExpr(a)})`;
        }
      }
      // atomic methods on an Atomic<T> receiver (the checker stamped obj.ty). Never lower to a plain int.
      if (e.callee.kind === "Member" && e.callee.obj.ty && atomicElem(e.callee.obj.ty) !== null) {
        const recv = emitExpr(e.callee.obj), m = e.callee.prop;
        const a = e.args.map(emitExpr);   // order idents emit as std::memory_order_*
        const T = cppType(atomicElem(e.callee.obj.ty)!);
        if (m === "load") return `${recv}.load(${a[0]})`;
        if (m === "store") return `${recv}.store(${a[0]}, ${a[1]})`;
        if (m === "fetchAdd") return `${recv}.fetch_add(${a[0]}, ${a[1]})`;
        if (m === "compareExchange") return `([&]{ ${T} _exp = (${T})(${a[0]}); return ${recv}.compare_exchange_strong(_exp, ${a[1]}, ${a[2]}, ${a[3]}); }())`;
      }
      if (isAtomicNew(e)) throw new Error("Atomic.new must directly initialize a binding or struct field");
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

// A non-Copy binding read as an RHS is a MOVE (the checker proved the source is not used afterward):
// emit std::move so we transfer the vector/string/struct rather than silently deep-copy. Variant idents
// and Copy values pass through unchanged.
function moveRhs(e: Expr): string {
  const code = emitExpr(e);
  return (e.kind === "Ident" && !VARIANTS.has(e.name) && !isCopy(e.ty ?? "")) ? `std::move(${code})` : code;
}

function emitStmt(s: Stmt, ind: string, ctx: string): string {
  switch (s.kind) {
    case "Let":
      if (isAtomicNew(s.value)) {   // brace direct-init: std::atomic is non-copyable/non-movable
        const arg = emitExpr((s.value as Extract<Expr, { kind: "Call" }>).args[0]);
        return `${ind}${cppType(s.declTy!)} ${s.name}{ ${arg} };`;
      }
      if (s.value.kind === "SpawnExpr" && s.value.call.kind === "Call") {   // named task -> std::thread
        const { fn, args } = spawnCallParts(s.value.call);
        return `${ind}std::thread ${s.name}(${[fn, ...args].join(", ")});`;
      }
      if (isBufferNew(s.value)) {
        const arg = emitExpr((s.value as Extract<Expr, { kind: "Call" }>).args[0]);
        return `${ind}${cppType(s.declTy!)} ${s.name} = ${cppType(s.declTy!)}(${arg});`;
      }
      return `${ind}${cppType(s.declTy!)} ${s.name} = ${moveRhs(s.value)};`;
    case "Assign": return `${ind}${emitExpr(s.target)} = ${moveRhs(s.value)};`;
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
    case "Scope": {
      const sv = `_sc${scopeCounter++}`;       // bare spawns inside push into this; all joined at end
      scopeVarStack.push(sv);
      const body = s.body.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n");
      scopeVarStack.pop();
      return `${ind}{\n${ind}  std::vector<std::thread> ${sv};\n${body}\n${ind}  for (auto& _t : ${sv}) _t.join();\n${ind}}`;
    }
    case "ExprStmt":
      if (s.expr.kind === "SpawnExpr" && s.expr.call.kind === "Call") {   // bare spawn -> scope's thread vector
        const { fn, args } = spawnCallParts(s.expr.call);
        return `${ind}${scopeVarStack[scopeVarStack.length - 1]}.emplace_back(${[fn, ...args].join(", ")});`;
      }
      return `${ind}${emitExpr(s.expr)};`;
  }
}

function emitParam(p: Param): string {
  return (bufferElem(p.ty) !== null || hasAtomic(p.ty)) ? `${cppType(p.ty)}& ${p.name}` : `${cppType(p.ty)} ${p.name}`;
}
function emitFn(fn: FnDecl): string {
  const body = fn.body.map((s) => emitStmt(s, "  ", fn.name === "main" ? "main" : (fn.retTy ? "value" : "void"))).join("\n");
  if (fn.name === "main") return `int main() {\n${body}\n  return 0;\n}`;
  const ret = fn.retTy ? cppType(fn.retTy) : "void";
  return `${ret} ${fn.name}(${fn.params.map(emitParam).join(", ")}) {\n${body}\n}`;
}
function emitKernel(k: KernelDecl): string {
  const body = k.body.map((s) => emitStmt(s, "  ", "void")).join("\n");
  const params = k.params.map(emitParam);
  return `void ${k.name}(uint32_t grid_x, uint32_t grid_y, uint32_t grid_z${params.length ? ", " + params.join(", ") : ""}) {\n${body}\n}`;
}

// ---- MSL (Metal Shading Language) backend for kernels ----
// Same kernel source, second target. Differences from the C++ path:
//   - native operators (no overflow-checked mz::add — the GPU can't trap)
//   - grid.{x,y,z} -> thread_position_in_grid; buf.len -> the buf_len uniform
//   - Metal scalar type names; no double (f64 maps to float)
function mslType(t: string): string {
  switch (t) {
    case "u8": return "uchar"; case "u16": return "ushort"; case "u32": return "uint"; case "u64": return "ulong";
    case "i8": return "char"; case "i16": return "short"; case "i32": return "int"; case "i64": return "long";
    case "intlit": return "int";
    case "f16": return "half"; case "f32": return "float"; case "f64": return "float"; case "floatlit": return "float";
    case "bool": return "bool";
    default:
      if (atomicElem(t) !== null) throw new Error("kernel: Atomic is not supported (GPU atomics are out of scope)");
      return t;   // user struct types map to their own name (must be MSL-compatible)
  }
}
// wrapping/saturating arithmetic collapse to the native operator (GPU ints wrap; saturation TBD)
const MSL_OP: Record<string, string> = {
  "+": "+", "-": "-", "*": "*", "/": "/", "%": "%",
  "+%": "+", "-%": "-", "*%": "*", "+|": "+", "-|": "-", "*|": "*",
};
function emitMslExpr(e: Expr, bufs: Set<string>): string {
  switch (e.kind) {
    case "Num": return e.value;
    case "Float": return e.value;
    case "Char": throw new Error("kernel: char literals are not allowed");
    case "Bool": return e.value ? "true" : "false";
    case "Cast": {
      if (!(isInt(e.toTy) || isFloat(e.toTy))) throw new Error("kernel: only numeric casts are allowed");
      return `(${mslType(e.toTy)})(${emitMslExpr(e.expr, bufs)})`;
    }
    case "Ident": return e.name;
    case "Member":
      if (e.obj.kind === "Ident" && e.obj.name === "grid") return `_tpig.${e.prop}`;
      if (e.obj.kind === "Ident" && bufs.has(e.obj.name) && e.prop === "len") return `${e.obj.name}_len`;
      return `${emitMslExpr(e.obj, bufs)}.${e.prop}`;
    case "Index": return `${emitMslExpr(e.obj, bufs)}[${emitMslExpr(e.index, bufs)}]`;
    case "Binary": {
      const l = emitMslExpr(e.left, bufs), r = emitMslExpr(e.right, bufs);
      return `(${l} ${MSL_OP[e.op] ?? e.op} ${r})`;
    }
    case "Str": throw new Error("kernel: strings are not allowed");
    case "Borrow": throw new Error("kernel: '&' borrows are not allowed");
    case "SpawnExpr": throw new Error("kernel: 'spawn' is not allowed");
    case "Call": throw new Error("kernel: function/variant calls are not allowed (M-stage)");
    case "StructLit": {
      const order = STRUCT_FIELDS.get(e.name) ?? e.fields.map((f) => f.name);
      const byName = new Map(e.fields.map((f) => [f.name, f.value]));
      const vals = order.map((fn) => { const v = byName.get(fn); return v ? emitMslExpr(v, bufs) : "{}"; });
      return `${e.name}{ ${vals.join(", ")} }`;
    }
  }
}
function emitMslStmt(s: Stmt, ind: string, bufs: Set<string>): string {
  switch (s.kind) {
    case "Let": return `${ind}${mslType(s.declTy!)} ${s.name} = ${emitMslExpr(s.value, bufs)};`;
    case "Assign": return `${ind}${emitMslExpr(s.target, bufs)} = ${emitMslExpr(s.value, bufs)};`;
    case "If": {
      const then = s.then.map((st) => emitMslStmt(st, ind + "  ", bufs)).join("\n");
      let out = `${ind}if (${emitMslExpr(s.cond, bufs)}) {\n${then}\n${ind}}`;
      if (s.els) out += ` else {\n${s.els.map((st) => emitMslStmt(st, ind + "  ", bufs)).join("\n")}\n${ind}}`;
      return out;
    }
    case "While": {
      const body = s.body.map((st) => emitMslStmt(st, ind + "  ", bufs)).join("\n");
      return `${ind}while (${emitMslExpr(s.cond, bufs)}) {\n${body}\n${ind}}`;
    }
    case "Return": return s.value ? `${ind}return ${emitMslExpr(s.value, bufs)};` : `${ind}return;`;
    case "Break": return `${ind}break;`;
    case "Continue": return `${ind}continue;`;
    case "ExprStmt": return `${ind}${emitMslExpr(s.expr, bufs)};`;
    case "Match": case "ForOf": case "Scope": throw new Error(`kernel: '${s.kind}' is not supported`);
  }
}
function emitMslKernel(k: KernelDecl): string {
  const bufs = new Set(k.params.filter((p) => bufferElem(p.ty) !== null).map((p) => p.name));
  const lenIdx = kernelLenIndex(k.params);
  const sig: string[] = [];
  k.params.forEach((p, i) => {
    const be = bufferElem(p.ty);
    if (be !== null) sig.push(`device ${mslType(be)}* ${p.name} [[buffer(${i})]]`);
    else sig.push(`constant ${mslType(p.ty)}& ${p.name} [[buffer(${i})]]`);
  });
  for (const [name, idx] of lenIdx) sig.push(`constant uint& ${name}_len [[buffer(${idx})]]`);
  sig.push(`uint3 _tpig [[thread_position_in_grid]]`);
  const body = k.body.map((s) => emitMslStmt(s, "  ", bufs)).join("\n");
  const indent = "\n                 ";
  return `#include <metal_stdlib>\nusing namespace metal;\nkernel void ${k.name}(${sig.join("," + indent)}) {\n${body}\n}`;
}
function methodSig(m: Method): string {   // return-type name(params) [const]  — &self -> const member
  return `${m.retTy ? cppType(m.retTy) : "void"} ${m.name}(${m.params.map(emitParam).join(", ")})${m.recv === "&self" ? " const" : ""}`;
}
function emitTypeDecl(it: StructDecl | EnumDecl): string {
  if (it.kind === "StructDecl") {
    const fields = it.fields.map((f) => `${cppType(f.ty)} ${f.name};`).join(" ");
    const decls = it.methods.map((m) => `${methodSig(m)};`).join(" ");   // declarations; bodies emitted out-of-line
    return `struct ${it.name} { ${[fields, decls].filter((s) => s).join(" ")} };`;
  }
  const fields: string[] = ["int tag;"];
  for (const v of it.variants) v.payload.forEach((pt, i) => fields.push(`${cppType(pt)} ${v.name}_${i};`));
  return `struct ${it.name} { ${fields.join(" ")} };`;
}
// Out-of-line method body: `ret Struct::method(params) const { ... }`. Emitted AFTER fn prototypes so
// a method body may call free functions; `self` lowers to (*this).
function emitMethodDef(structName: string, m: Method): string {
  const body = m.body.map((s) => emitStmt(s, "  ", m.retTy ? "value" : "void")).join("\n");
  return `${m.retTy ? cppType(m.retTy) : "void"} ${structName}::${m.name}(${m.params.map(emitParam).join(", ")})${m.recv === "&self" ? " const" : ""} {\n${body}\n}`;
}

export function emit(prog: Program, target: "cpu" | "metal" = "cpu"): string {
  const types = prog.items.filter((it): it is StructDecl | EnumDecl => it.kind === "StructDecl" || it.kind === "EnumDecl");
  const kernels = prog.items.filter((it): it is KernelDecl => it.kind === "KernelDecl");
  const fns = prog.items.filter((it): it is FnDecl => it.kind === "FnDecl");

  STRUCT_FIELDS = new Map();
  STRUCT_FIELD_TYPES = new Map();
  VARIANTS = new Map();
  KERNELS = new Map();
  FN_PARAMS = new Map();
  TARGET = target;
  matchCounter = 0;
  scopeCounter = 0;
  for (const it of types) {
    if (it.kind === "StructDecl") { STRUCT_FIELDS.set(it.name, it.fields.map((f) => f.name)); STRUCT_FIELD_TYPES.set(it.name, it.fields.map((f) => f.ty)); }
    else it.variants.forEach((v, idx) => VARIANTS.set(v.name, { enumName: it.name, index: idx, payload: v.payload }));
  }
  for (const k of kernels) KERNELS.set(k.name, k.params);
  for (const f of fns) FN_PARAMS.set(f.name, f.params);

  const typeDecls = types.map(emitTypeDecl).join("\n");
  // Metal: kernels become MSL source strings (compiled at runtime); no C++ kernel fn/proto.
  // CPU:   kernels become C++ functions launched by a serial mz::launch loop.
  const mslDecls = target === "metal"
    ? kernels.map((k) => `static const char* _msl_${k.name} = R"MSL(\n${emitMslKernel(k)}\n)MSL";`).join("\n\n")
    : "";
  const byRefTy = (p: Param) => (bufferElem(p.ty) !== null || hasAtomic(p.ty)) ? cppType(p.ty) + "&" : cppType(p.ty);
  const kernelProtos = target === "metal" ? "" : kernels.map((k) => `void ${k.name}(uint32_t, uint32_t, uint32_t${k.params.map((p) => ", " + byRefTy(p)).join("")});`).join("\n");
  const fnProtos = fns.filter((f) => f.name !== "main").map((f) => `${f.retTy ? cppType(f.retTy) : "void"} ${f.name}(${f.params.map(byRefTy).join(", ")});`).join("\n");
  const protos = [kernelProtos, fnProtos].filter((s) => s).join("\n");
  // Struct method bodies, out-of-line, AFTER prototypes so a method may call free functions.
  const methodDefs = types.flatMap((it) => it.kind === "StructDecl" ? it.methods.map((m) => emitMethodDef(it.name, m)) : []).join("\n\n");
  const defs = [...(target === "metal" ? [] : kernels.map(emitKernel)), ...fns.map(emitFn)].join("\n\n");
  // Pull in <atomic> / <thread> only when the program actually uses them (the emitted code names them).
  const allCode = typeDecls + mslDecls + protos + methodDefs + defs;
  const sysIncludes = (allCode.includes("std::atomic") ? "#include <atomic>\n" : "") +
                      (allCode.includes("std::thread") ? "#include <thread>\n" : "") +
                      (allCode.includes("std::move") ? "#include <utility>\n" : "");
  return `// generated by mozaic (M0)${target === "metal" ? " [Metal/MSL backend]" : ""}
${sysIncludes}#include "mozaic_rt.h"

${typeDecls ? typeDecls + "\n\n" : ""}${mslDecls ? mslDecls + "\n\n" : ""}${protos ? protos + "\n\n" : ""}${methodDefs ? methodDefs + "\n\n" : ""}${defs}
`;
}
