// AST node types + shared type-system helpers.

export type Program = { kind: "Program"; items: Item[] };
export type Item = FnDecl | StructDecl | EnumDecl | KernelDecl | ConstDecl | Import;
export type ConstDecl = { kind: "ConstDecl"; name: string; ty: string; value: Expr; cval?: CTValue };
export type Import = { kind: "Import"; path: string };   // `import "path";` — resolved by the driver
export type Param = { name: string; ty: string };
export type Field = { name: string; ty: string };
export type Variant = { name: string; payload: string[] };
export type Method = { name: string; recv: "self" | "&self" | "&mut self"; params: Param[]; retTy: string | null; body: Stmt[] };
export type StructDecl = { kind: "StructDecl"; name: string; fields: Field[]; methods: Method[]; typeParams?: string[] };
export type EnumDecl = { kind: "EnumDecl"; name: string; variants: Variant[] };
export type FnDecl = { kind: "FnDecl"; name: string; params: Param[]; retTy: string | null; body: Stmt[]; typeParams?: string[] };
export type KernelDecl = { kind: "KernelDecl"; name: string; params: Param[]; body: Stmt[] };
export type Arm = { variant: string; bindings: string[]; body: Stmt[] };
export type Stmt =
  | { kind: "Let"; name: string; annot: string | null; value: Expr; declTy?: string; isConst?: boolean }
  | { kind: "Assign"; target: Expr; value: Expr }
  | { kind: "While"; cond: Expr; body: Stmt[] }
  | { kind: "ForOf"; binder: string; iter: Expr; body: Stmt[] }
  | { kind: "If"; cond: Expr; then: Stmt[]; els: Stmt[] | null }
  | { kind: "Match"; scrut: Expr; arms: Arm[] }
  | { kind: "Return"; value: Expr | null }
  | { kind: "Break" }
  | { kind: "Continue" }
  | { kind: "Scope"; body: Stmt[] }
  | { kind: "Defer"; body: Stmt[] }          // run `body` at enclosing-scope exit, LIFO
  | { kind: "ExprStmt"; expr: Expr };
export type Expr =
  | { kind: "Num"; value: string; ty?: string }
  | { kind: "Float"; value: string; ty?: string }
  | { kind: "Str"; value: string; ty?: string }
  | { kind: "Char"; value: string; ty?: string }   // value = codepoint (decimal); type `char` (UTF-32)
  | { kind: "Bool"; value: boolean; ty?: string }
  | { kind: "Cast"; expr: Expr; toTy: string; opt: boolean; ty?: string }   // `e as T` / `e as? T`
  | { kind: "Some"; expr: Expr; ty?: string }       // some(x) : T?
  | { kind: "None"; ty?: string }                   // none — fits any T?
  | { kind: "Try"; expr: Expr; ty?: string }        // postfix e? — propagate none/Err (early return)
  | { kind: "OrElse"; opt: Expr; alt: Expr; ty?: string }   // a ?? b — unwrap or default
  | { kind: "Ok"; expr: Expr; ty?: string }         // Ok(x)  : Result<T, E>
  | { kind: "Err"; expr: Expr; ty?: string }        // Err(e) : Result<T, E>
  | { kind: "Array"; elems: Expr[]; ty?: string }   // [a, b, c] : [T; N]
  | { kind: "Template"; strings: string[]; exprs: Expr[]; ty?: string }   // `a${e}b` : str (strings.length == exprs.length + 1)
  | { kind: "Ident"; name: string; ty?: string }
  | { kind: "Member"; obj: Expr; prop: string; ty?: string }
  | { kind: "Index"; obj: Expr; index: Expr; ty?: string }
  | { kind: "Call"; callee: Expr; args: Expr[]; ty?: string }
  | { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[]; ty?: string }
  | { kind: "Borrow"; mut: boolean; expr: Expr; ty?: string }
  | { kind: "SpawnExpr"; call: Expr; ty?: string }
  | { kind: "Comptime"; expr: Expr; ty?: string; cval?: CTValue }   // comptime e — fold to a constant at build time
  | { kind: "Unary"; op: string; expr: Expr; ty?: string }          // prefix !x (logical not)
  | { kind: "Binary"; op: string; left: Expr; right: Expr; ty?: string };

// A compile-time constant value produced by the comptime evaluator (see comptime.ts).
export type CTValue =
  | { k: "int"; v: bigint }
  | { k: "float"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "char"; v: number }                              // codepoint
  | { k: "str"; v: string }
  | { k: "arr"; elem: string; v: CTValue[] }              // elem = element type
  | { k: "struct"; name: string; fields: Map<string, CTValue> };

export type Sig = { params: Param[]; retTy: string | null; typeParams?: string[] };
export type VarInfo = { enumName: string; index: number; payload: string[] };

// ---------- type-system helpers ----------
export const INTS = ["i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128"];
export const FLOATS = ["f16", "f32", "f64"];
export function isInt(t: string): boolean { return t === "intlit" || INTS.includes(t); }
export function isFloat(t: string): boolean { return t === "floatlit" || FLOATS.includes(t); }
export function isUnsigned(t: string): boolean { return t !== "intlit" && t.startsWith("u"); }
// SIMD vector type `<scalar>x<lanes>` (e.g. f32x4, i16x8, u64x2). null if not a vector type.
export function vecParts(t: string): { scalar: string; lanes: number } | null {
  const m = /^([iuf](?:8|16|32|64|128))x([0-9]+)$/.exec(t);
  if (!m) return null;
  const scalar = m[1], lanes = parseInt(m[2], 10);
  if (lanes < 2 || !(INTS.includes(scalar) || FLOATS.includes(scalar))) return null;
  return { scalar, lanes };
}
// Copy types are duplicated freely on assign/pass; everything else is move-only (single owner).
// Non-Copy: str/String, Buffer<T>, structs, enums-with-payload, Atomic<...>.
export function isCopy(t: string): boolean {
  if (sliceElem(t) !== null) return true;                       // a slice is a cheap {ptr,len} view
  if (vecParts(t) !== null) return true;                        // a SIMD vector is a flat value
  const ap = arrayParts(t); if (ap !== null) return isCopy(ap[0]);   // [T;N] is Copy iff T is
  return isInt(t) || isFloat(t) || t === "bool" || t === "char";
}
// References are encoded as a string prefix: `&T` (shared) / `&mut T` (exclusive).
export function isRef(t: string): boolean { return t.startsWith("&"); }
export function isMutRef(t: string): boolean { return t.startsWith("&mut "); }
export function refInner(t: string): string | null { return t.startsWith("&mut ") ? t.slice(5) : (t.startsWith("&") ? t.slice(1) : null); }
export function bufferElem(t: string): string | null { return t.startsWith("Buffer<") && t.endsWith(">") ? t.slice(7, -1) : null; }
// Optionals are encoded as a trailing `?` (like refs use a leading `&`). `i32?` -> std::optional<int32_t>.
export function optInner(t: string): string | null { return (!t.startsWith("&") && t.endsWith("?")) ? t.slice(0, -1) : null; }
// Slices are `[]T` (a {ptr,len} view); fixed arrays are `[T;N]`.
export function sliceElem(t: string): string | null { return t.startsWith("[]") ? t.slice(2) : null; }
export function arrayParts(t: string): [string, string] | null {   // [T;N] -> [T, N]
  if (!t.startsWith("[") || t.startsWith("[]") || !t.endsWith("]")) return null;
  const inner = t.slice(1, -1);
  const semi = inner.lastIndexOf(";");   // lastIndex so nested arrays [[i32;2];3] split outermost
  return semi < 0 ? null : [inner.slice(0, semi).trim(), inner.slice(semi + 1).trim()];
}
// Generic application `Name<a, b, ...>` -> { base, args } (top-level commas, < > nesting). null if not applied.
export function genericArgs(t: string): { base: string; args: string[] } | null {
  if (!t.endsWith(">")) return null;
  const lt = t.indexOf("<");
  if (lt <= 0) return null;
  const base = t.slice(0, lt);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) return null;   // base must be a plain name (not [..]<..> etc.)
  const inner = t.slice(lt + 1, -1);
  const args: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) { args.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  args.push(inner.slice(start).trim());
  return { base, args };
}
// Result<T, E> -> [T, E], splitting on the top-level comma (respecting < > nesting). null if not a Result.
export function resultArgs(t: string): [string, string] | null {
  if (!t.startsWith("Result<") || !t.endsWith(">")) return null;
  const inner = t.slice(7, -1);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
  }
  return null;
}
export function atomicElem(t: string): string | null { return t.startsWith("Atomic<") && t.endsWith(">") ? t.slice(7, -1) : null; }
export const ATOMIC_INTS = ["u32", "i32", "u64", "i64"];   // the only legal T in Atomic<T>
// Concurrency library generics. Mutex/Channel are Sync (shared by &T across threads, like Atomic).
// Arc is owned-but-shareable (passed by value via .clone(); NOT a Sync &-shared type).
export const SYNC_BASES = ["Mutex", "Channel"];
export const LIB_GENERICS = ["Arc", "Mutex", "Channel", "MutexGuard", "Vec"];   // built-in generic type constructors
export function isVecNew(e: Expr): boolean { return e.kind === "Call" && e.callee.kind === "Member" && e.callee.obj.kind === "Ident" && e.callee.obj.name === "Vec" && e.callee.prop === "new"; }
export function dynVecElem(t: string): string | null { const g = genericArgs(t); return g !== null && g.base === "Vec" ? g.args[0] : null; }
// A type shared by &T across threads (Sync): Mutex / Channel (and refs to them). Used alongside
// hasAtomic for spawn by-ref params, multi-`&` borrows, non-Copy, and borrow->value coercion.
export function isSyncShared(t: string): boolean {
  const ri = refInner(t); if (ri !== null) return isSyncShared(ri);
  const g = genericArgs(t); return g !== null && SYNC_BASES.includes(g.base);
}
export function libBase(t: string): string | null { const g = genericArgs(t); return g !== null && LIB_GENERICS.includes(g.base) ? g.base : null; }
export function isArcNew(e: Expr): boolean { return e.kind === "Call" && e.callee.kind === "Member" && e.callee.obj.kind === "Ident" && e.callee.obj.name === "Arc" && e.callee.prop === "new"; }
export function isMutexNew(e: Expr): boolean { return e.kind === "Call" && e.callee.kind === "Member" && e.callee.obj.kind === "Ident" && e.callee.obj.name === "Mutex" && e.callee.prop === "new"; }
export function isChannelNew(e: Expr): boolean { return e.kind === "Call" && e.callee.kind === "Member" && e.callee.obj.kind === "Ident" && e.callee.obj.name === "Channel" && e.callee.prop === "new"; }
// Does a type transitively contain an Atomic? (Atomic itself / Buffer of atomic / struct with an atomic field.)
// structFields maps a struct name -> its field type strings (built by check.ts and emit.ts).
export function containsAtomic(t: string, structFields: Map<string, string[]>, seen = new Set<string>()): boolean {
  if (atomicElem(t) !== null) return true;
  const oi = optInner(t); if (oi !== null) return containsAtomic(oi, structFields, seen);   // T?  (don't smuggle an Atomic through an optional)
  const se = sliceElem(t); if (se !== null) return containsAtomic(se, structFields, seen);   // []T
  const ap = arrayParts(t); if (ap !== null) return containsAtomic(ap[0], structFields, seen);   // [T;N]
  const be = bufferElem(t); if (be !== null) return containsAtomic(be, structFields, seen);
  const ra = resultArgs(t); if (ra !== null) return containsAtomic(ra[0], structFields, seen) || containsAtomic(ra[1], structFields, seen);
  const g = genericArgs(t); if (g !== null) return g.args.some((a) => containsAtomic(a, structFields, seen));   // generic struct instance: conservative
  if (seen.has(t)) return false;
  const fields = structFields.get(t);
  if (fields) { seen.add(t); return fields.some((ft) => containsAtomic(ft, structFields, seen)); }
  return false;
}
// Replace generic type-param names (per `b`) everywhere they appear inside a type encoding.
export function substituteType(t: string, b: Map<string, string>): string {
  if (b.has(t)) return b.get(t)!;
  if (t.startsWith("&mut ")) return "&mut " + substituteType(t.slice(5), b);
  if (t.startsWith("&")) return "&" + substituteType(t.slice(1), b);
  const oi = optInner(t); if (oi !== null) return substituteType(oi, b) + "?";
  const se = sliceElem(t); if (se !== null) return "[]" + substituteType(se, b);
  const ap = arrayParts(t); if (ap !== null) return `[${substituteType(ap[0], b)};${ap[1]}]`;
  const be = bufferElem(t); if (be !== null) return `Buffer<${substituteType(be, b)}>`;
  const ae = atomicElem(t); if (ae !== null) return `Atomic<${substituteType(ae, b)}>`;
  const ra = resultArgs(t); if (ra !== null) return `Result<${substituteType(ra[0], b)}, ${substituteType(ra[1], b)}>`;
  const g = genericArgs(t); if (g !== null) return `${g.base}<${g.args.map((a) => substituteType(a, b)).join(", ")}>`;   // generic struct instance
  return t;
}
export function unifyInt(a: string, b: string): string | null {
  if (!isInt(a) || !isInt(b)) return null;
  if (a === "intlit") return b;
  if (b === "intlit") return a;
  return a === b ? a : null;
}
export function unifyFloat(a: string, b: string): string | null {
  if (!isFloat(a) || !isFloat(b)) return null;
  if (a === "floatlit") return b;
  if (b === "floatlit") return a;
  return a === b ? a : null;
}
export function cppType(t: string): string {
  const se = sliceElem(t);
  if (se !== null) return `mz::Slice<${cppType(se)}>`;
  const ap = arrayParts(t);
  if (ap !== null) return `std::array<${cppType(ap[0])}, ${ap[1]}>`;
  const oi = optInner(t);
  if (oi !== null) return `std::optional<${cppType(oi)}>`;
  const ri = refInner(t);
  if (ri !== null) return isMutRef(t) ? `${cppType(ri)}&` : `const ${cppType(ri)}&`;   // &T -> const T& / &mut T -> T&
  switch (t) {
    case "i8": return "int8_t"; case "i16": return "int16_t"; case "i32": return "int32_t"; case "i64": return "int64_t";
    case "u8": return "uint8_t"; case "u16": return "uint16_t"; case "u32": return "uint32_t"; case "u64": return "uint64_t";
    case "i128": return "__int128"; case "u128": return "unsigned __int128";
    case "intlit": return "int32_t";
    case "f16": return "_Float16"; case "f32": return "float"; case "f64": return "double"; case "floatlit": return "double";
    case "bool": return "bool";
    case "char": return "char32_t";
    case "str": return "mz::String";
    case "Device": return "mz::Device";
    case "Job": return "mz::Job";
    case "Grid": return "mz::Grid";
    default: {
      const vp = vecParts(t);
      if (vp !== null) return `mz::Simd<${cppType(vp.scalar)}, ${vp.lanes}>`;
      const ae = atomicElem(t);
      if (ae !== null) return `std::atomic<${cppType(ae)}>`;
      const be = bufferElem(t);
      if (be !== null) return `mz::Buffer<${cppType(be)}>`;
      const ra = resultArgs(t);
      if (ra !== null) return `mz::Result<${cppType(ra[0])}, ${cppType(ra[1])}>`;
      const g = genericArgs(t);   // a generic struct instance Name<args> -> Name<cppArgs...>
      if (g !== null) return `${LIB_GENERICS.includes(g.base) ? "mz::" + g.base : g.base}<${g.args.map(cppType).join(", ")}>`;
      return t;   // user struct/enum types (and bare type params) map to their own name
    }
  }
}
export const BUILTIN_TYPES = new Set([...INTS, ...FLOATS, "bool", "char", "str", "Device", "Job", "Grid"]);
export const ARITH_OPS = ["+", "-", "*", "/", "%", "+%", "-%", "*%", "+|", "-|", "*|"];
export const ARITH_FN: Record<string, string> = {
  "+": "add", "-": "sub", "*": "mul", "/": "divi", "%": "modi",
  "+%": "wadd", "-%": "wsub", "*%": "wmul",
  "+|": "sadd", "-|": "ssub", "*|": "smul",
};

export function isStdinLines(e: Expr): boolean {
  return e.kind === "Call" && e.callee.kind === "Member" &&
    e.callee.obj.kind === "Ident" && e.callee.obj.name === "stdin" && e.callee.prop === "lines";
}
export function isBufferNew(e: Expr): boolean {
  return e.kind === "Call" && e.callee.kind === "Member" &&
    e.callee.obj.kind === "Ident" && e.callee.obj.name === "Buffer" && e.callee.prop === "shared";
}
export function isAtomicNew(e: Expr): boolean {
  return e.kind === "Call" && e.callee.kind === "Member" &&
    e.callee.obj.kind === "Ident" && e.callee.obj.name === "Atomic" && e.callee.prop === "new";
}
