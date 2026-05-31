// Code generation: typed AST -> C++ source.
import type { Program, Stmt, Expr, Param, StructDecl, EnumDecl, FnDecl, KernelDecl, VarInfo } from "./ast.ts";
import { isInt, isUnsigned, isFloat, bufferElem, cppType, ARITH_FN, isBufferNew } from "./ast.ts";

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
    case "Member":
      if (e.obj.kind === "Ident" && e.obj.name === "grid") return `grid_${e.prop}`;
      return `${emitExpr(e.obj)}.${e.prop}`;
    case "Index": return `${emitExpr(e.obj)}[${emitExpr(e.index)}]`;
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
      if (fn && isInt(e.ty ?? "")) return `mz::${fn}<${cppType(e.ty!)}>(${l}, ${r})`;
      return `(${l} ${e.op} ${r})`;
    }
    case "Call": {
      if (e.callee.kind === "Ident" && e.callee.name === "launch") {
        const kn = (e.args[0] as Extract<Expr, { kind: "Ident" }>).name;
        const grid = emitExpr(e.args[1]);
        const kargs = e.args.slice(2).map(emitExpr);
        return `mz::launch(${grid}, [&](uint32_t grid_x){ ${kn}(grid_x${kargs.length ? ", " + kargs.join(", ") : ""}); })`;
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
    case "Let":
      if (isBufferNew(s.value)) {
        const arg = emitExpr((s.value as Extract<Expr, { kind: "Call" }>).args[0]);
        return `${ind}${cppType(s.declTy!)} ${s.name} = ${cppType(s.declTy!)}(${arg});`;
      }
      return `${ind}${cppType(s.declTy!)} ${s.name} = ${emitExpr(s.value)};`;
    case "Assign": return `${ind}${emitExpr(s.target)} = ${emitExpr(s.value)};`;
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

function emitParam(p: Param): string {
  return bufferElem(p.ty) !== null ? `${cppType(p.ty)}& ${p.name}` : `${cppType(p.ty)} ${p.name}`;
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
  return `void ${k.name}(uint32_t grid_x${params.length ? ", " + params.join(", ") : ""}) {\n${body}\n}`;
}
function emitTypeDecl(it: StructDecl | EnumDecl): string {
  if (it.kind === "StructDecl") return `struct ${it.name} { ${it.fields.map((f) => `${cppType(f.ty)} ${f.name};`).join(" ")} };`;
  const fields: string[] = ["int tag;"];
  for (const v of it.variants) v.payload.forEach((pt, i) => fields.push(`${cppType(pt)} ${v.name}_${i};`));
  return `struct ${it.name} { ${fields.join(" ")} };`;
}

export function emit(prog: Program): string {
  const types = prog.items.filter((it): it is StructDecl | EnumDecl => it.kind === "StructDecl" || it.kind === "EnumDecl");
  const kernels = prog.items.filter((it): it is KernelDecl => it.kind === "KernelDecl");
  const fns = prog.items.filter((it): it is FnDecl => it.kind === "FnDecl");

  STRUCT_FIELDS = new Map();
  VARIANTS = new Map();
  matchCounter = 0;
  for (const it of types) {
    if (it.kind === "StructDecl") STRUCT_FIELDS.set(it.name, it.fields.map((f) => f.name));
    else it.variants.forEach((v, idx) => VARIANTS.set(v.name, { enumName: it.name, index: idx, payload: v.payload }));
  }

  const typeDecls = types.map(emitTypeDecl).join("\n");
  const kernelProtos = kernels.map((k) => `void ${k.name}(uint32_t${k.params.map((p) => ", " + (bufferElem(p.ty) !== null ? cppType(p.ty) + "&" : cppType(p.ty))).join("")});`).join("\n");
  const fnProtos = fns.filter((f) => f.name !== "main").map((f) => `${f.retTy ? cppType(f.retTy) : "void"} ${f.name}(${f.params.map((p) => bufferElem(p.ty) !== null ? cppType(p.ty) + "&" : cppType(p.ty)).join(", ")});`).join("\n");
  const protos = [kernelProtos, fnProtos].filter((s) => s).join("\n");
  const defs = [...kernels.map(emitKernel), ...fns.map(emitFn)].join("\n\n");
  return `// generated by mozaic (M0)
#include "mozaic_rt.h"

${typeDecls ? typeDecls + "\n\n" : ""}${protos ? protos + "\n\n" : ""}${defs}
`;
}
