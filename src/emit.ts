// Code generation: typed AST -> C++ source.
import type { Program, Stmt, Expr, Param, StructDecl, EnumDecl, FnDecl, KernelDecl, ConstDecl, Method, VarInfo, CTValue } from "./ast.ts";
import { isInt, isUnsigned, isFloat, isCopy, bufferElem, atomicElem, optInner, resultArgs, sliceElem, arrayParts, refInner, containsAtomic, cppType, ARITH_FN, isBufferNew, isAtomicNew, vecParts, genericArgs } from "./ast.ts";

let STRUCT_FIELDS = new Map<string, string[]>();
let STRUCT_FIELD_TYPES = new Map<string, string[]>();   // struct name -> field types (parallel to STRUCT_FIELDS)
let VARIANTS = new Map<string, VarInfo>();
let KERNELS = new Map<string, Param[]>();
let FN_PARAMS = new Map<string, Param[]>();              // fn name -> params (to decide std::ref in spawn)
let TARGET: "cpu" | "metal" = "cpu";
let matchCounter = 0;
let scopeCounter = 0;
let deferCounter = 0;
const scopeVarStack: string[] = [];                      // current scope's std::thread vector name

// Memory orderings lower to std::memory_order_* (SPEC §5). A bare Ordering ident emits the constant.
const ORDER_CPP: Record<string, string> = {
  Relaxed: "std::memory_order_relaxed", Acquire: "std::memory_order_acquire",
  Release: "std::memory_order_release", AcqRel: "std::memory_order_acq_rel",
  SeqCst: "std::memory_order_seq_cst",
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
  let out = 'U"';   // char32_t string literal -> constructs an mz::String (std::u32string)
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return out + '"_mz';   // _mz UDL -> mz::String prvalue (avoids const char32_t* -> bool surprises)
}

// One interpolation/format argument -> mz::format(...). Casts like println so the right overload binds.
function formatArg(e: Expr): string {
  const at = e.ty ?? "unit";
  const x = emitExpr(e);
  if (at === "char") return `mz::format((char32_t)(${x}))`;
  if (at === "i128") return `mz::format((__int128)(${x}))`;
  if (at === "u128") return `mz::format((unsigned __int128)(${x}))`;
  if (isInt(at)) return `mz::format((${isUnsigned(at) ? "unsigned long long" : "long long"})(${x}))`;
  if (isFloat(at)) return `mz::format((double)(${x}))`;
  return `mz::format(${x})`;   // str / bool
}

// Render an integer literal as a valid C++ token (suffixes for >63-bit; 128-bit via hi<<64|lo).
function renderInt(v: bigint): string {
  if (v < 0n) return `(-${renderInt(-v)})`;
  if (v <= 9223372036854775807n) return v.toString();
  if (v <= 18446744073709551615n) return v.toString() + "ull";
  const hi = v >> 64n, lo = v & ((1n << 64n) - 1n);
  return `(((unsigned __int128)${renderInt(hi)} << 64) | (unsigned __int128)${lo}ull)`;
}
function renderFloat(v: number): string {
  if (Number.isNaN(v)) return "__builtin_nan(\"\")";
  if (v === Infinity) return "__builtin_inf()";
  if (v === -Infinity) return "(-__builtin_inf())";
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + ".0";   // keep it a floating literal
}
// A comptime value -> C++ initializer text. Arrays use the std::array double-brace form;
// structs are filled in declared field order (matches the StructLit emitter).
function renderCT(v: CTValue): string {
  switch (v.k) {
    case "int": return renderInt(v.v);
    case "float": return renderFloat(v.v);
    case "bool": return v.v ? "true" : "false";
    case "char": return `(char32_t)${v.v}`;
    case "str": return cstr(v.v);
    case "arr": return `{{ ${v.v.map(renderCT).join(", ")} }}`;
    case "struct": {
      const base = v.name.includes("<") ? v.name.slice(0, v.name.indexOf("<")) : v.name;
      const order = STRUCT_FIELDS.get(base) ?? [...v.fields.keys()];
      return `${cppType(v.name)}{ ${order.map((fn) => (v.fields.has(fn) ? renderCT(v.fields.get(fn)!) : "{}")).join(", ")} }`;
    }
  }
}

function emitExpr(e: Expr): string {
  switch (e.kind) {
    case "Comptime": return renderCT(e.cval!);
    case "Num": return e.value;
    case "Float": return e.value;
    case "Str": return cstr(e.value);
    case "Char": return `(char32_t)${e.value}`;
    case "Bool": return e.value ? "true" : "false";
    case "Cast":
      return e.opt
        ? `mz::checked_cast<${cppType(e.toTy)}, ${cppType(e.expr.ty!)}>(${emitExpr(e.expr)})`   // as? -> std::optional
        : `(${cppType(e.toTy)})(${emitExpr(e.expr)})`;                                          // as  -> explicit cast
    case "Some": return `{ ${emitExpr(e.expr)} }`;   // braced -> adapts to the target std::optional<T>
    case "None": return "{}";                        // empty optional (nullopt) via the target type
    case "Ok":  return `{ true, ${emitExpr(e.expr)} }`;       // mz::Result aggregate: {ok, val, err=default}
    case "Err": return `{ false, {}, ${emitExpr(e.expr)} }`;  // {ok=false, val=default, err}
    case "Array": return `{{ ${e.elems.map(emitExpr).join(", ")} }}`;   // double brace: std::array wraps a C-array (works flat AND nested)
    case "Template": {   // `a${e}b` -> (U"a"_mz + format(e) + U"b"_mz) : mz::String
      const parts = [cstr(e.strings[0])];
      for (let k = 0; k < e.exprs.length; k++) { parts.push(formatArg(e.exprs[k])); parts.push(cstr(e.strings[k + 1])); }
      return `(${parts.join(" + ")})`;
    }
    case "OrElse": return `(${emitExpr(e.opt)}).value_or(${emitExpr(e.alt)})`;
    case "Try":   // GCC/clang statement-expression: unwrap, or early-return the empty/Err carrier
      return resultArgs(e.expr.ty ?? "") !== null
        ? `({ auto _r = (${emitExpr(e.expr)}); if (!_r.ok) return { false, {}, _r.err }; _r.val; })`
        : `({ auto _o = (${emitExpr(e.expr)}); if (!_o.has_value()) return {}; _o.value(); })`;
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
      // std::array and mz::String use .size(); Buffer/Slice have a .len member.
      if (e.prop === "len") {
        const ot = refInner(e.obj.ty ?? "") ?? e.obj.ty ?? "";
        if (arrayParts(ot) !== null || ot === "str") return `(uint32_t)(${emitExpr(e.obj)}).size()`;
        const vp = vecParts(ot); if (vp !== null) return `(uint32_t)${vp.lanes}`;   // lane count (comptime constant)
      }
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
      return `${cppType(e.ty ?? e.name)}{ ${vals.join(", ")} }`;   // generic -> Name<cppArgs>{...}; plain -> Name{...}
    }
    case "Binary": {
      // optional presence test: opt == none / opt != none -> has_value()
      if ((e.op === "==" || e.op === "!=") && (e.left.kind === "None" || e.right.kind === "None")) {
        const opt = e.left.kind === "None" ? e.right : e.left;
        const has = `(${emitExpr(opt)}).has_value()`;
        return e.op === "==" ? `(!${has})` : `(${has})`;
      }
      const l = emitExpr(e.left), r = emitExpr(e.right);
      if (e.op === "==") return e.left.ty === "str" ? `mz::eq(${l}, ${r})` : `(${l} == ${r})`;
      if (e.op === "!=") return e.left.ty === "str" ? `(!mz::eq(${l}, ${r}))` : `(${l} != ${r})`;
      if (e.op === "+" && e.left.ty === "str") return `(${l} + ${r})`;   // String concatenation
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
      // SIMD vector lane-constructor f32x4(a,b,c,d) -> mz::Vec<float,4>{ {a,b,c,d} }
      if (e.callee.kind === "Ident" && vecParts(e.callee.name) !== null)
        return `${cppType(e.callee.name)}{ { ${e.args.map(emitExpr).join(", ")} } }`;
      if (e.callee.kind === "Ident" && e.callee.name === "format") return formatArg(e.args[0]);
      if (e.callee.kind === "Ident" && e.callee.name === "slice") {   // slice(arr) -> mz::Slice{ ptr, len }
        const elem = sliceElem(e.ty ?? "[]i32")!;
        const arr = emitExpr(e.args[0]);
        return `mz::Slice<${cppType(elem)}>{ (${arr}).data(), (uint32_t)(${arr}).size() }`;
      }
      if (e.callee.kind === "Ident" && e.callee.name === "abort")
        return e.args.length === 1 ? `mz::panic_msg(${emitExpr(e.args[0])})` : `mz::panic("aborted")`;
      if (e.callee.kind === "Ident" && e.callee.name === "assert")
        return `mz::assert_(${e.args.map(emitExpr).join(", ")})`;
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
        if (vecParts(recv) !== null && m === "splat") return `${cppType(recv)}::splat(${emitExpr(e.args[0])})`;
        if (recv === "clock" && m === "now") return `mz::now_ns()`;
        if (recv === "stdin" && m === "lines") return `mz::stdin_lines()`;
        if (recv === "stdout" && m === "println") {
          const a = e.args[0];
          const at = a.ty ?? "unit";
          if (at === "str" || at === "bool") return `mz::println(${emitExpr(a)})`;
          if (at === "char") return `mz::println((char32_t)(${emitExpr(a)}))`;
          if (at === "i128") return `mz::println((__int128)(${emitExpr(a)}))`;
          if (at === "u128") return `mz::println((unsigned __int128)(${emitExpr(a)}))`;
          if (isInt(at)) return `mz::println((${isUnsigned(at) ? "unsigned long long" : "long long"})(${emitExpr(a)}))`;
          if (isFloat(at)) return `mz::println((double)(${emitExpr(a)}))`;
          return `mz::println(${emitExpr(a)})`;
        }
      }
      // Result<T,E> terminal accessors (the checker stamped obj.ty).
      if (e.callee.kind === "Member" && e.callee.obj.ty && resultArgs(e.callee.obj.ty) !== null) {
        const recv = emitExpr(e.callee.obj), m = e.callee.prop;
        if (m === "isOk") return `(${recv}).ok`;
        if (m === "isErr") return `(!(${recv}).ok)`;
        if (m === "unwrap") return `mz::result_unwrap(${recv})`;
        if (m === "unwrapErr") return `mz::result_unwrap_err(${recv})`;
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
      // Task<R>.join() -> future.get() (returns R). Void Task.join() falls through to std::thread::join().
      if (e.callee.kind === "Member" && e.callee.prop === "join" && genericArgs(e.callee.obj.ty ?? "")?.base === "Task")
        return `${emitExpr(e.callee.obj)}.get()`;
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
      if (s.value.kind === "SpawnExpr" && s.value.call.kind === "Call") {
        const { fn, args } = spawnCallParts(s.value.call);
        const g = genericArgs(s.declTy ?? "");
        if (g && g.base === "Task")   // Task<R>: result-returning task -> std::future via std::async; join() == get()
          return `${ind}std::future<${cppType(g.args[0])}> ${s.name} = std::async(std::launch::async, ${[fn, ...args].join(", ")});`;
        return `${ind}std::thread ${s.name}(${[fn, ...args].join(", ")});`;   // void task -> std::thread
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
    case "Defer": {   // RAII guard: destructor runs body at enclosing C++ scope exit (LIFO, also on return)
      const body = s.body.map((st) => emitStmt(st, ind + "  ", ctx)).join("\n");
      return `${ind}auto _def${deferCounter++} = mz::defer([&]{\n${body}\n${ind}});`;
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
  const tmpl = fn.typeParams && fn.typeParams.length ? `template <${fn.typeParams.map((t) => `class ${t}`).join(", ")}>\n` : "";
  return `${tmpl}${ret} ${fn.name}(${fn.params.map(emitParam).join(", ")}) {\n${body}\n}`;
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
  if (optInner(t) !== null) throw new Error("kernel: optional types are not allowed");
  if (resultArgs(t) !== null) throw new Error("kernel: Result types are not allowed");
  if (sliceElem(t) !== null || arrayParts(t) !== null) throw new Error("kernel: array/slice types are not allowed");
  const vp = vecParts(t);
  if (vp !== null) {   // MSL native vectors: 2/3/4 lanes only, no 64/128-bit element types
    const base: Record<string, string> = { i8: "char", u8: "uchar", i16: "short", u16: "ushort", i32: "int", u32: "uint", f16: "half", f32: "float" };
    if (!(vp.scalar in base)) throw new Error(`kernel: vector element ${vp.scalar} is not supported in MSL`);
    if (vp.lanes < 2 || vp.lanes > 4) throw new Error(`kernel: MSL vectors support 2-4 lanes (got ${t})`);
    return base[vp.scalar] + vp.lanes;
  }
  switch (t) {
    case "u8": return "uchar"; case "u16": return "ushort"; case "u32": return "uint"; case "u64": return "ulong";
    case "i8": return "char"; case "i16": return "short"; case "i32": return "int"; case "i64": return "long";
    case "i128": case "u128": throw new Error("kernel: 128-bit integers are not supported in MSL");
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
    case "Comptime": {   // folded constant: only scalars make sense in a kernel
      const v = e.cval!;
      if (v.k === "int") return v.v.toString();
      if (v.k === "float") return renderFloat(v.v);
      if (v.k === "bool") return v.v ? "true" : "false";
      throw new Error("kernel: only scalar comptime values are allowed");
    }
    case "Char": throw new Error("kernel: char literals are not allowed");
    case "Bool": return e.value ? "true" : "false";
    case "Cast": {
      if (e.opt || !(isInt(e.toTy) || isFloat(e.toTy))) throw new Error("kernel: only plain numeric casts are allowed");
      return `(${mslType(e.toTy)})(${emitMslExpr(e.expr, bufs)})`;
    }
    case "Some": case "None": case "Try": case "OrElse": throw new Error("kernel: optionals are not allowed");
    case "Ok": case "Err": throw new Error("kernel: Result is not allowed");
    case "Array": throw new Error("kernel: array literals are not allowed");
    case "Template": throw new Error("kernel: template strings are not allowed");
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
    case "Call": {
      // SIMD vectors are the only calls allowed in a kernel: f32x4(a,b,c,d) / f32x4.splat(s) -> float4(...)
      if (e.callee.kind === "Ident" && vecParts(e.callee.name) !== null)
        return `${mslType(e.callee.name)}(${e.args.map((a) => emitMslExpr(a, bufs)).join(", ")})`;
      if (e.callee.kind === "Member" && e.callee.obj.kind === "Ident" && vecParts(e.callee.obj.name) !== null && e.callee.prop === "splat")
        return `${mslType(e.callee.obj.name)}(${emitMslExpr(e.args[0], bufs)})`;
      throw new Error("kernel: function/variant calls are not allowed (M-stage)");
    }
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
    case "Match": case "ForOf": case "Scope": case "Defer": throw new Error(`kernel: '${s.kind}' is not supported`);
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
    if (it.typeParams && it.typeParams.length) {   // generic struct -> class template (methods as out-of-line template members)
      return `template <${it.typeParams.map((t) => `class ${t}`).join(", ")}> struct ${it.name} { ${[fields, decls].filter((s) => s).join(" ")} };`;
    }
    return `struct ${it.name} { ${[fields, decls].filter((s) => s).join(" ")} };`;
  }
  const fields: string[] = ["int tag;"];
  for (const v of it.variants) v.payload.forEach((pt, i) => fields.push(`${cppType(pt)} ${v.name}_${i};`));
  return `struct ${it.name} { ${fields.join(" ")} };`;
}
// Out-of-line method body: `ret Struct::method(params) const { ... }`. Emitted AFTER fn prototypes so
// a method body may call free functions; `self` lowers to (*this).
function emitMethodDef(structName: string, m: Method, typeParams: string[] = []): string {
  const body = m.body.map((s) => emitStmt(s, "  ", m.retTy ? "value" : "void")).join("\n");
  const ret = m.retTy ? cppType(m.retTy) : "void";
  const cv = m.recv === "&self" ? " const" : "";
  const sig = `(${m.params.map(emitParam).join(", ")})${cv}`;
  if (typeParams.length) {   // out-of-line template member: template <class T> ret Name<T>::m(...) { ... }
    return `template <${typeParams.map((t) => `class ${t}`).join(", ")}>\n${ret} ${structName}<${typeParams.join(", ")}>::${m.name}${sig} {\n${body}\n}`;
  }
  return `${ret} ${structName}::${m.name}${sig} {\n${body}\n}`;
}

export function emit(prog: Program, target: "cpu" | "metal" = "cpu"): string {
  const types = prog.items.filter((it): it is StructDecl | EnumDecl => it.kind === "StructDecl" || it.kind === "EnumDecl");
  const kernels = prog.items.filter((it): it is KernelDecl => it.kind === "KernelDecl");
  const fns = prog.items.filter((it): it is FnDecl => it.kind === "FnDecl");
  const consts = prog.items.filter((it): it is ConstDecl => it.kind === "ConstDecl");

  STRUCT_FIELDS = new Map();
  STRUCT_FIELD_TYPES = new Map();
  VARIANTS = new Map();
  KERNELS = new Map();
  FN_PARAMS = new Map();
  TARGET = target;
  matchCounter = 0;
  scopeCounter = 0;
  deferCounter = 0;
  for (const it of types) {
    if (it.kind === "StructDecl") { STRUCT_FIELDS.set(it.name, it.fields.map((f) => f.name)); STRUCT_FIELD_TYPES.set(it.name, it.fields.map((f) => f.ty)); }
    else it.variants.forEach((v, idx) => VARIANTS.set(v.name, { enumName: it.name, index: idx, payload: v.payload }));
  }
  for (const k of kernels) KERNELS.set(k.name, k.params);
  for (const f of fns) FN_PARAMS.set(f.name, f.params);

  const typeDecls = types.map(emitTypeDecl).join("\n");
  // Top-level consts -> file-scope `static const` globals (folded at build time; defined before fns use them).
  const constDecls = consts.map((c) => `static const ${cppType(c.ty)} ${c.name} = ${renderCT(c.cval!)};`).join("\n");
  // Metal: kernels become MSL source strings (compiled at runtime); no C++ kernel fn/proto.
  // CPU:   kernels become C++ functions launched by a serial mz::launch loop.
  const mslDecls = target === "metal"
    ? kernels.map((k) => `static const char* _msl_${k.name} = R"MSL(\n${emitMslKernel(k)}\n)MSL";`).join("\n\n")
    : "";
  const byRefTy = (p: Param) => (bufferElem(p.ty) !== null || hasAtomic(p.ty)) ? cppType(p.ty) + "&" : cppType(p.ty);
  const kernelProtos = target === "metal" ? "" : kernels.map((k) => `void ${k.name}(uint32_t, uint32_t, uint32_t${k.params.map((p) => ", " + byRefTy(p)).join("")});`).join("\n");
  const isGeneric = (f: FnDecl) => !!(f.typeParams && f.typeParams.length);
  // Generic fns are C++ templates: no separate prototype, and emitted (fully) before any caller.
  const fnProtos = fns.filter((f) => f.name !== "main" && !isGeneric(f)).map((f) => `${f.retTy ? cppType(f.retTy) : "void"} ${f.name}(${f.params.map(byRefTy).join(", ")});`).join("\n");
  const protos = [kernelProtos, fnProtos].filter((s) => s).join("\n");
  const genericDefs = fns.filter(isGeneric).map(emitFn).join("\n\n");   // after protos (can call non-generic fns), before methods/defs
  // Struct method bodies, out-of-line, AFTER prototypes so a method may call free functions.
  const methodDefs = types.flatMap((it) => it.kind === "StructDecl" ? it.methods.map((m) => emitMethodDef(it.name, m, it.typeParams ?? [])) : []).join("\n\n");
  const defs = [...(target === "metal" ? [] : kernels.map(emitKernel)), ...fns.filter((f) => !isGeneric(f)).map(emitFn)].join("\n\n");
  // Pull in <atomic> / <thread> only when the program actually uses them (the emitted code names them).
  const allCode = typeDecls + constDecls + mslDecls + protos + genericDefs + methodDefs + defs;
  const sysIncludes = (allCode.includes("std::atomic") ? "#include <atomic>\n" : "") +
                      (allCode.includes("std::thread") ? "#include <thread>\n" : "") +
                      (allCode.includes("std::async") || allCode.includes("std::future") ? "#include <future>\n" : "") +
                      (allCode.includes("std::move") ? "#include <utility>\n" : "");
  return `// generated by mozaic (M0)${target === "metal" ? " [Metal/MSL backend]" : ""}
${sysIncludes}#include "mozaic_rt.h"

${typeDecls ? typeDecls + "\n\n" : ""}${constDecls ? constDecls + "\n\n" : ""}${mslDecls ? mslDecls + "\n\n" : ""}${protos ? protos + "\n\n" : ""}${genericDefs ? genericDefs + "\n\n" : ""}${methodDefs ? methodDefs + "\n\n" : ""}${defs}
`;
}
