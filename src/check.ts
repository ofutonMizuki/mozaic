// Semantic analysis: name resolution + strict type checking.
import type { Program, Stmt, Expr, Param, Sig, VarInfo } from "./ast.ts";
import {
  BUILTIN_TYPES, ARITH_OPS, ATOMIC_INTS, isInt, isFloat, unifyInt, unifyFloat,
  bufferElem, atomicElem, containsAtomic, isStdinLines, isBufferNew, isAtomicNew,
} from "./ast.ts";

// borrow = device sync: a buffer borrowed by an in-flight Job (between dev.launch and
// job.await) cannot be touched by the host. & = shared (CPU reads still OK), &mut = exclusive.
// The same machinery backs spawn/scope/join: a task holds its &/&mut args until it joins.
type Borrow = { mut: boolean; job: string };

// Memory orderings (SPEC §5; SeqCst intentionally omitted). Atomic ops take a LITERAL one.
const ORDERINGS = new Set(["Relaxed", "Acquire", "Release", "AcqRel"]);

class Checker {
  errs: string[] = [];
  scopes: Map<string, string>[] = [];
  fns = new Map<string, Sig>();
  kernels = new Map<string, Param[]>();
  structs = new Map<string, Map<string, string>>();
  enums = new Map<string, Map<string, string[]>>();
  variants = new Map<string, VarInfo>();
  curRet = "unit";
  borrows = new Map<string, Borrow>();   // buffer/atomic name -> in-flight borrow (per function)
  suppressBufRead: string | null = null;  // the lvalue buffer of the current Assign (write, not read)
  inKernel = false;                        // checking a kernel body? (Atomic is banned there)
  tasks = new Map<string, { joined: boolean }>();  // named spawn Tasks -> joined yet? (per function)
  scopeStack: string[] = [];               // active scope ids (bare spawns join at scope end)
  scopeCount = 0;
  target: "cpu" | "metal" = "cpu";         // emit target (Buffer<Atomic<T>> is CPU-only)
  // Does a type transitively contain an Atomic? (uses the registered struct field types)
  hasAtomic(t: string): boolean {
    const sf = new Map<string, string[]>();
    for (const [n, fm] of this.structs) sf.set(n, [...fm.values()]);
    return containsAtomic(t, sf);
  }
  // Message if a type carries an Atomic<T> with an illegal T (else null).
  badAtomicElem(t: string): string | null {
    const ae = atomicElem(t);
    if (ae !== null && !ATOMIC_INTS.includes(ae)) return `Atomic<${ae}>: T must be one of u32, i32, u64, i64`;
    const be = bufferElem(t);
    return be !== null ? this.badAtomicElem(be) : null;
  }
  accessBuf(name: string, write: boolean) {
    const b = this.borrows.get(name);
    if (!b) return;
    if (write) this.err(`'${name}' is borrowed by in-flight job '${b.job}'; await it before writing (borrow = device sync)`);
    else if (b.mut) this.err(`'${name}' is exclusively borrowed (&mut) by in-flight job '${b.job}'; await it before reading (borrow = device sync)`);
    // a shared (&) borrow leaves the host free to read concurrently
  }
  registerBorrows(call: Extract<Expr, { kind: "Call" }>, job: string) {
    const kn = call.args[0];
    if (kn.kind !== "Ident") return;
    const kparams = this.kernels.get(kn.name);
    if (!kparams) return;
    call.args.slice(2).forEach((a, k) => {
      const p = kparams[k];
      if (!p || bufferElem(p.ty) === null) return;
      if (a.kind !== "Borrow" || a.expr.kind !== "Ident") return;
      const name = a.expr.name;
      if (this.borrows.has(name)) this.err(`'${name}' is already borrowed in-flight; await before launching again`);
      else this.borrows.set(name, { mut: a.mut, job });
    });
  }
  // spawn f(args): validate like a call; by-ref params (Buffer / atomic-containing) must be borrowed.
  checkSpawnArgs(call: Extract<Expr, { kind: "Call" }>) {
    if (call.callee.kind !== "Ident" || !this.fns.has(call.callee.name)) { this.err("spawn requires a call to a named function"); return; }
    const sig = this.fns.get(call.callee.name)!;
    if (call.args.length !== sig.params.length) this.err(`spawn '${call.callee.name}': expected ${sig.params.length} arg(s), got ${call.args.length}`);
    for (let k = 0; k < call.args.length; k++) {
      const a = call.args[k], p = sig.params[k];
      const at = this.checkExpr(a);
      if (!p) continue;
      const byRef = bufferElem(p.ty) !== null || this.hasAtomic(p.ty);
      if (byRef) {
        if (a.kind !== "Borrow" || a.expr.kind !== "Ident") this.err(`spawn arg ${k + 1}: '${p.name}' must be borrowed (&${p.name} or &mut ${p.name})`);
      } else if (a.kind === "Borrow") this.err(`spawn arg ${k + 1}: scalar '${p.name}' must not be borrowed`);
      if (!this.assignable(at, p.ty)) this.err(`spawn arg ${k + 1}: cannot pass ${at} as ${p.ty}`);
    }
  }
  // A task holds its &/&mut args until it joins (job = task name, or the scope id for bare spawns).
  // & of an atomic-containing type is Sync: multiple concurrent shared borrows are allowed.
  registerSpawnBorrows(call: Extract<Expr, { kind: "Call" }>, job: string) {
    if (call.callee.kind !== "Ident") return;
    const sig = this.fns.get(call.callee.name);
    if (!sig) return;
    call.args.forEach((a, k) => {
      const p = sig.params[k];
      if (!p || (bufferElem(p.ty) === null && !this.hasAtomic(p.ty))) return;
      if (a.kind !== "Borrow" || a.expr.kind !== "Ident") return;
      const name = a.expr.name;
      const existing = this.borrows.get(name);
      if (existing) { if (existing.mut || a.mut) this.err(`'${name}' is already borrowed in-flight; await/join before borrowing again`); }
      else this.borrows.set(name, { mut: a.mut, job });
    });
  }
  // Atomic ops (load/store/fetchAdd/compareExchange): arg types vs T, and order/method compatibility.
  checkAtomicMethod(e: Extract<Expr, { kind: "Call" }>, t: string): string {
    const m = (e.callee as Extract<Expr, { kind: "Member" }>).prop;
    const order = (a: Expr | undefined, allowed: string[], label: string) => {
      if (!a || a.kind !== "Ident" || !ORDERINGS.has(a.name)) this.err(`${label} order must be a literal Ordering variant (Relaxed/Acquire/Release/AcqRel)`);
      else if (!allowed.includes(a.name)) this.err(`${label} order must be one of ${allowed.join(", ")} (got ${a.name})`);
    };
    const val = (a: Expr | undefined, k: number) => { if (a) { const at = this.checkExpr(a); if (!this.assignable(at, t)) this.err(`atomic ${m} arg ${k}: cannot pass ${at} as ${t}`); } };
    switch (m) {
      case "load":
        if (e.args.length !== 1) this.err("load(order) takes 1 argument"); else order(e.args[0], ["Relaxed", "Acquire"], "load's");
        return (e.ty = t);
      case "store":
        if (e.args.length !== 2) this.err("store(value, order) takes 2 arguments"); else { val(e.args[0], 1); order(e.args[1], ["Relaxed", "Release"], "store's"); }
        return (e.ty = "unit");
      case "fetchAdd":
        if (e.args.length !== 2) this.err("fetchAdd(value, order) takes 2 arguments"); else { val(e.args[0], 1); order(e.args[1], ["Relaxed", "Acquire", "Release", "AcqRel"], "fetchAdd's"); }
        return (e.ty = t);
      case "compareExchange":
        if (e.args.length !== 4) this.err("compareExchange(expected, desired, success, failure) takes 4 arguments");
        else { val(e.args[0], 1); val(e.args[1], 2); order(e.args[2], ["Relaxed", "Acquire", "Release", "AcqRel"], "compareExchange success"); order(e.args[3], ["Relaxed", "Acquire"], "compareExchange failure"); }
        return (e.ty = "bool");
      default:
        this.err(`unknown atomic method '${m}' (use load / store / fetchAdd / compareExchange)`);
        return (e.ty = "unit");
    }
  }
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
    if (t === "Task") return true;                    // spawn handle
    if (atomicElem(t) !== null) return true;          // element legality -> badAtomicElem (better msg)
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
      for (const f of it.fields) {
        if (!this.typeKnown(f.ty)) this.err(`unknown type '${f.ty}' for field '${it.name}.${f.name}'`);
        const bad = this.badAtomicElem(f.ty); if (bad) this.err(`${bad} (field '${it.name}.${f.name}')`);
      }
    for (const it of p.items) if (it.kind === "EnumDecl")
      for (const v of it.variants) for (const pt of v.payload) {
        if (!this.typeKnown(pt)) this.err(`unknown type '${pt}' in variant '${v.name}'`);
        if (this.hasAtomic(pt)) this.err(`Atomic is not allowed in enum payloads (variant '${v.name}')`);
      }
    for (const it of p.items) if (it.kind === "KernelDecl") {
      if (this.kernels.has(it.name)) this.err(`duplicate kernel '${it.name}'`);
      this.kernels.set(it.name, it.params);
      for (const pa of it.params) {
        if (!this.typeKnown(pa.ty)) this.err(`unknown type '${pa.ty}' for kernel param '${pa.name}'`);
        if (this.hasAtomic(pa.ty)) this.err(`Atomic is not supported inside a kernel (parameter '${pa.name}')`);
      }
    }
    for (const it of p.items) if (it.kind === "FnDecl") {
      if (this.fns.has(it.name)) this.err(`duplicate function '${it.name}'`);
      this.fns.set(it.name, { params: it.params, retTy: it.retTy });
      for (const pa of it.params) {
        if (!this.typeKnown(pa.ty)) this.err(`unknown type '${pa.ty}' for parameter '${pa.name}'`);
        const bad = this.badAtomicElem(pa.ty); if (bad) this.err(`${bad} (parameter '${pa.name}')`);
      }
      if (it.retTy && !this.typeKnown(it.retTy)) this.err(`unknown return type '${it.retTy}' for '${it.name}'`);
      if (it.retTy && this.hasAtomic(it.retTy)) this.err(`'${it.name}': cannot return an atomic-containing type by value`);
    }
    if (!this.fns.has("main")) this.err("no `main` function");
    const main = this.fns.get("main");
    if (main && (main.params.length > 0 || main.retTy)) this.err("`main` must take no parameters and declare no return type");
    for (const it of p.items) if (it.kind === "FnDecl" || it.kind === "KernelDecl") {
      this.push();
      this.curRet = (it.kind === "FnDecl" ? it.retTy : null) ?? "unit";
      this.borrows = new Map();
      this.tasks = new Map();
      this.inKernel = it.kind === "KernelDecl";
      for (const pa of it.params) this.define(pa.name, pa.ty);
      for (const s of it.body) this.checkStmt(s);
      for (const [name, b] of this.borrows) this.err(`'${name}' is still borrowed by job '${b.job}' at end of '${it.name}'; await/join before it goes out of scope`);
      for (const [name, t] of this.tasks) if (!t.joined) this.err(`'${name}' is a Task that was never joined; join it before it goes out of scope`);
      this.inKernel = false;
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
          const bad = this.badAtomicElem(s.annot);
          if (!this.typeKnown(s.annot)) { this.err(`unknown type '${s.annot}'`); declTy = "i32"; }
          else if (bad) { this.err(`${bad} ('${s.name}')`); declTy = s.annot; }
          else if (!this.assignable(vt, s.annot)) { this.err(`type mismatch: cannot init '${s.name}: ${s.annot}' with ${vt}`); declTy = s.annot; }
          else declTy = s.annot;
        } else {
          if (vt === "buffernew") { this.err(`'${s.name}': Buffer.shared needs a type annotation (e.g. : Buffer<f32>)`); declTy = "i32"; }
          else if (vt === "atomicnew") { this.err(`'${s.name}': Atomic.new needs a type annotation (e.g. : Atomic<u64>)`); declTy = "i32"; }
          else if (vt === "Ordering") { this.err(`Ordering is not a storable value; pass a literal Ordering only to atomic operations`); declTy = "i32"; }
          else { declTy = vt === "intlit" ? "i32" : (vt === "floatlit" ? "f64" : vt);
            if (declTy === "str-iter" || declTy === "unit" || declTy === "unknown") { this.err(`cannot bind '${s.name}' to ${vt}`); declTy = "i32"; } }
        }
        s.declTy = declTy;
        this.define(s.name, declTy);
        // Atomic<T>: validate the initial value against T.
        const ael = atomicElem(declTy);
        if (ael !== null && isAtomicNew(s.value)) {
          const arg = (s.value as Extract<Expr, { kind: "Call" }>).args[0];
          if (arg && !this.assignable(arg.ty ?? "unit", ael)) this.err(`Atomic.new: cannot init Atomic<${ael}> with ${arg.ty}`);
        }
        // Buffer<Atomic<...>> is CPU-only (the Metal buffer is raw bytes; std::atomic can't alias it).
        if (this.target === "metal" && bufferElem(declTy) !== null && this.hasAtomic(declTy))
          this.err(`Buffer<Atomic<...>> is not supported on the GPU/Metal target (Atomic is host-only)`);
        // atomic-containing values are non-copyable/non-movable: only fresh construction or & sharing.
        if (this.hasAtomic(declTy) && !isAtomicNew(s.value) && !isBufferNew(s.value) && s.value.kind !== "StructLit")
          this.err(`'${s.name}': atomic-containing values cannot be copied or moved (construct in place, or share via &Atomic)`);
        // `let job = dev.launch(...)` borrows its buffer args until job.await()
        if (declTy === "Job" && s.value.kind === "Call" &&
            s.value.callee.kind === "Member" && s.value.callee.prop === "launch")
          this.registerBorrows(s.value, s.name);
        // `let t: Task = spawn f(...)` holds its &/&mut args until t.join()
        if (declTy === "Task" && s.value.kind === "SpawnExpr" && s.value.call.kind === "Call") {
          this.tasks.set(s.name, { joined: false });
          this.registerSpawnBorrows(s.value.call, s.name);
        }
        break;
      }
      case "Assign": {
        if (s.target.kind === "Index" && s.target.obj.kind === "Ident") {
          this.accessBuf(s.target.obj.name, true);     // writing through the buffer
          this.suppressBufRead = s.target.obj.name;     // ...so don't also flag it as a read
        }
        const tt = this.checkExpr(s.target);
        this.suppressBufRead = null;
        if (this.hasAtomic(tt)) { this.err(`cannot assign to an Atomic; use .store(value, order)`); break; }
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
      case "Scope": {
        const sid = "scope#" + (this.scopeCount++);   // bare spawns inside join here
        this.scopeStack.push(sid);
        this.push();
        for (const st of s.body) this.checkStmt(st);
        this.pop();
        this.scopeStack.pop();
        for (const [name, b] of [...this.borrows]) if (b.job === sid) this.borrows.delete(name);
        break;
      }
      case "ExprStmt": {
        this.checkExpr(s.expr);
        const e = s.expr;
        // a bare `spawn f(...)` (not bound to a Task) must live in a scope; it joins at scope end.
        if (e.kind === "SpawnExpr") {
          if (this.scopeStack.length === 0) this.err("a bare `spawn` must be inside a scope { } (or bind it: let t: Task = spawn ...)");
          else if (e.call.kind === "Call") this.registerSpawnBorrows(e.call, this.scopeStack[this.scopeStack.length - 1]);
        }
        // job.await() / task.join() return the borrows held by that job/task.
        if (e.kind === "Call" && e.callee.kind === "Member" && e.callee.obj.kind === "Ident" &&
            (e.callee.prop === "await" || e.callee.prop === "join")) {
          const job = e.callee.obj.name;
          if (e.callee.prop === "join") { const t = this.tasks.get(job); if (t) t.joined = true; }
          for (const [name, b] of [...this.borrows]) if (b.job === job) this.borrows.delete(name);
        }
        break;
      }
    }
  }
  assignable(vt: string, tt: string): boolean {
    if (vt === "buffernew" && bufferElem(tt) !== null) return true;
    if (vt === "atomicnew" && atomicElem(tt) !== null) return true;
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
        if (ORDERINGS.has(e.name)) { e.ty = "Ordering"; return e.ty; }
        const v = this.variants.get(e.name);
        if (v && v.payload.length === 0) { e.ty = v.enumName; return e.ty; }
        this.err(`undefined variable '${e.name}'`); e.ty = "i32"; return e.ty;
      }
      case "Member": {
        if (e.obj.kind === "Ident" && e.obj.name === "grid" && (e.prop === "x" || e.prop === "y" || e.prop === "z")) { e.ty = "u32"; return e.ty; }
        if (e.obj.kind === "Ident" && e.obj.name === "Device" && (e.prop === "gpu" || e.prop === "cpu")) { e.ty = "Device"; return e.ty; }
        const ot = this.checkExpr(e.obj);
        if (bufferElem(ot) !== null && e.prop === "len") {
          if (e.obj.kind === "Ident") this.accessBuf(e.obj.name, false);
          e.ty = "u32"; return e.ty;
        }
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
        if (e.obj.kind === "Ident" && this.suppressBufRead !== e.obj.name) this.accessBuf(e.obj.name, false);
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
              const gt = this.checkExpr(e.args[1]);
              if (gt !== "Grid" && !isInt(gt)) this.err("launch: grid must be an integer or grid2(...)/grid3(...)");
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
        if (isAtomicNew(e)) {
          if (this.inKernel) this.err("Atomic is not supported inside a kernel (GPU atomics are out of scope)");
          if (e.args.length === 1) this.checkExpr(e.args[0]);
          else this.err("Atomic.new takes one argument (the initial value)");
          e.ty = "atomicnew"; return e.ty;
        }
        // grid2(w,h) / grid3(w,h,d): build a multi-dimensional launch grid
        if (e.callee.kind === "Ident" && (e.callee.name === "grid2" || e.callee.name === "grid3")) {
          const want = e.callee.name === "grid2" ? 2 : 3;
          if (e.args.length !== want) this.err(`${e.callee.name} takes ${want} integer dimensions`);
          for (const a of e.args) if (!isInt(this.checkExpr(a))) this.err(`${e.callee.name}: dimensions must be integers`);
          e.ty = "Grid"; return e.ty;
        }
        // dev.launch(kernel, grid, &buf, &mut out, ...scalars) -> Job  (async; borrows held until await)
        if (e.callee.kind === "Member" && e.callee.prop === "launch") {
          if (this.checkExpr(e.callee.obj) !== "Device") this.err("'.launch' can only be called on a Device");
          if (e.args.length < 2) this.err("launch needs (kernel, grid, ...args)");
          else {
            const kn = e.args[0];
            if (kn.kind !== "Ident" || !this.kernels.has(kn.name)) this.err("launch: first argument must be a kernel name");
            else {
              const kparams = this.kernels.get(kn.name)!;
              const gt = this.checkExpr(e.args[1]);
              if (gt !== "Grid" && !isInt(gt)) this.err("launch: grid must be an integer or grid2(...)/grid3(...)");
              const passed = e.args.slice(2);
              if (passed.length !== kparams.length) this.err(`launch '${kn.name}': expected ${kparams.length} kernel arg(s), got ${passed.length}`);
              for (let k = 0; k < passed.length; k++) {
                const a = passed[k], p = kparams[k];
                const at = this.checkExpr(a);
                if (!p) continue;
                if (bufferElem(p.ty) !== null) {
                  if (a.kind !== "Borrow" || a.expr.kind !== "Ident") this.err(`launch arg ${k + 1}: buffer must be borrowed (&${p.name} or &mut ${p.name})`);
                } else if (a.kind === "Borrow") this.err(`launch arg ${k + 1}: scalar '${p.name}' must not be borrowed`);
                if (!this.assignable(at, p.ty)) this.err(`launch arg ${k + 1}: cannot pass ${at} as ${p.ty}`);
              }
            }
          }
          e.ty = "Job"; return e.ty;
        }
        if (e.callee.kind === "Member" && e.callee.prop === "await") {
          if (this.checkExpr(e.callee.obj) !== "Job") this.err("'.await' can only be called on a Job");
          if (e.args.length) this.err("await takes no arguments");
          e.ty = "unit"; return e.ty;
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
          if (recv === "clock" && m === "now") {
            if (e.args.length) this.err("clock.now() takes no arguments");
            e.ty = "u64"; return e.ty;
          }
          if (recv === "stdin" && m === "lines") { e.ty = "str-iter"; return e.ty; }
          if (recv === "stdout" && m === "println") {
            const at = e.args.length === 1 ? this.checkExpr(e.args[0]) : "unit";
            if (!(at === "str" || at === "bool" || isInt(at) || isFloat(at))) this.err(`stdout.println: cannot print ${at}`);
            e.ty = "unit"; return e.ty;
          }
        }
        // atomic methods on an Atomic<T> receiver (load/store/fetchAdd/compareExchange), and task.join().
        if (e.callee.kind === "Member") {
          const recvTy = this.checkExpr(e.callee.obj);
          const ae = atomicElem(recvTy);
          if (ae !== null) {
            if (this.inKernel) this.err("Atomic is not supported inside a kernel (GPU atomics are out of scope)");
            return this.checkAtomicMethod(e, ae);
          }
          if (recvTy === "Task" && e.callee.prop === "join") {
            if (e.args.length) this.err("join() takes no arguments");
            e.ty = "unit"; return e.ty;
          }
        }
        this.err("M0: unsupported call"); e.ty = "unit"; return e.ty;
      }
      case "Borrow": {
        const it = this.checkExpr(e.expr);
        if (bufferElem(it) === null && !this.hasAtomic(it)) this.err(`'&' borrow is only for Buffer or Atomic arguments (got ${it})`);
        e.ty = it; return e.ty;
      }
      case "SpawnExpr": {
        if (this.inKernel) this.err("spawn is not allowed inside a kernel");
        if (e.call.kind === "Call") this.checkSpawnArgs(e.call);
        else this.err("spawn requires a function call");
        e.ty = "Task"; return e.ty;
      }
      case "Binary": {
        const lt = this.checkExpr(e.left), rt = this.checkExpr(e.right);
        if (this.hasAtomic(lt) || this.hasAtomic(rt)) { this.err(`Atomic can only be accessed via load/store/fetchAdd/compareExchange (not used as a value)`); e.ty = "i32"; return e.ty; }
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

export function check(prog: Program, target: "cpu" | "metal" = "cpu"): string[] {
  const c = new Checker();
  c.target = target;
  c.checkProgram(prog);
  return c.errs;
}
