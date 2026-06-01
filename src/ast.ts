// AST node types + shared type-system helpers.

export type Program = { kind: "Program"; items: Item[] };
export type Item = FnDecl | StructDecl | EnumDecl | KernelDecl;
export type Param = { name: string; ty: string };
export type Field = { name: string; ty: string };
export type Variant = { name: string; payload: string[] };
export type Method = { name: string; recv: "self" | "&self" | "&mut self"; params: Param[]; retTy: string | null; body: Stmt[] };
export type StructDecl = { kind: "StructDecl"; name: string; fields: Field[]; methods: Method[] };
export type EnumDecl = { kind: "EnumDecl"; name: string; variants: Variant[] };
export type FnDecl = { kind: "FnDecl"; name: string; params: Param[]; retTy: string | null; body: Stmt[] };
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
  | { kind: "ExprStmt"; expr: Expr };
export type Expr =
  | { kind: "Num"; value: string; ty?: string }
  | { kind: "Float"; value: string; ty?: string }
  | { kind: "Str"; value: string; ty?: string }
  | { kind: "Char"; value: string; ty?: string }   // value = codepoint (decimal); type `char` (UTF-32)
  | { kind: "Ident"; name: string; ty?: string }
  | { kind: "Member"; obj: Expr; prop: string; ty?: string }
  | { kind: "Index"; obj: Expr; index: Expr; ty?: string }
  | { kind: "Call"; callee: Expr; args: Expr[]; ty?: string }
  | { kind: "StructLit"; name: string; fields: { name: string; value: Expr }[]; ty?: string }
  | { kind: "Borrow"; mut: boolean; expr: Expr; ty?: string }
  | { kind: "SpawnExpr"; call: Expr; ty?: string }
  | { kind: "Binary"; op: string; left: Expr; right: Expr; ty?: string };

export type Sig = { params: Param[]; retTy: string | null };
export type VarInfo = { enumName: string; index: number; payload: string[] };

// ---------- type-system helpers ----------
export const INTS = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64"];
export const FLOATS = ["f32", "f64"];
export function isInt(t: string): boolean { return t === "intlit" || INTS.includes(t); }
export function isFloat(t: string): boolean { return t === "floatlit" || FLOATS.includes(t); }
export function isUnsigned(t: string): boolean { return t !== "intlit" && t.startsWith("u"); }
// Copy types are duplicated freely on assign/pass; everything else is move-only (single owner).
// Non-Copy: str/String, Buffer<T>, structs, enums-with-payload, Atomic<...>.
export function isCopy(t: string): boolean { return isInt(t) || isFloat(t) || t === "bool" || t === "char"; }
// References are encoded as a string prefix: `&T` (shared) / `&mut T` (exclusive).
export function isRef(t: string): boolean { return t.startsWith("&"); }
export function isMutRef(t: string): boolean { return t.startsWith("&mut "); }
export function refInner(t: string): string | null { return t.startsWith("&mut ") ? t.slice(5) : (t.startsWith("&") ? t.slice(1) : null); }
export function bufferElem(t: string): string | null { return t.startsWith("Buffer<") && t.endsWith(">") ? t.slice(7, -1) : null; }
export function atomicElem(t: string): string | null { return t.startsWith("Atomic<") && t.endsWith(">") ? t.slice(7, -1) : null; }
export const ATOMIC_INTS = ["u32", "i32", "u64", "i64"];   // the only legal T in Atomic<T>
// Does a type transitively contain an Atomic? (Atomic itself / Buffer of atomic / struct with an atomic field.)
// structFields maps a struct name -> its field type strings (built by check.ts and emit.ts).
export function containsAtomic(t: string, structFields: Map<string, string[]>, seen = new Set<string>()): boolean {
  if (atomicElem(t) !== null) return true;
  const be = bufferElem(t);
  if (be !== null) return containsAtomic(be, structFields, seen);
  if (seen.has(t)) return false;
  const fields = structFields.get(t);
  if (fields) { seen.add(t); return fields.some((ft) => containsAtomic(ft, structFields, seen)); }
  return false;
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
  const ri = refInner(t);
  if (ri !== null) return isMutRef(t) ? `${cppType(ri)}&` : `const ${cppType(ri)}&`;   // &T -> const T& / &mut T -> T&
  switch (t) {
    case "i8": return "int8_t"; case "i16": return "int16_t"; case "i32": return "int32_t"; case "i64": return "int64_t";
    case "u8": return "uint8_t"; case "u16": return "uint16_t"; case "u32": return "uint32_t"; case "u64": return "uint64_t";
    case "intlit": return "int32_t";
    case "f32": return "float"; case "f64": return "double"; case "floatlit": return "double";
    case "bool": return "bool";
    case "char": return "char32_t";
    case "str": return "mz::String";
    case "Device": return "mz::Device";
    case "Job": return "mz::Job";
    case "Grid": return "mz::Grid";
    default: {
      const ae = atomicElem(t);
      if (ae !== null) return `std::atomic<${cppType(ae)}>`;
      const be = bufferElem(t);
      if (be !== null) return `mz::Buffer<${cppType(be)}>`;
      return t;   // user struct/enum types map to their own name
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
