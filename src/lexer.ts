// Tokenizer.
export type Tok = { t: string; v: string; pos: number };

const KEYWORDS = new Set(["function", "kernel", "struct", "enum", "match", "for", "while", "of", "if", "else", "return", "break", "continue", "const", "let", "mut", "scope", "spawn", "true", "false", "as", "defer", "some", "none", "comptime"]);

export function lex(src: string): Tok[] {
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
    if (c === "`") {   // template string `lit ${expr} lit` -> a single tmpl token (parser splits + reparses ${})
      i++;
      let raw = "";
      let brace = 0;   // 0 = literal region; >0 = inside ${ ... } (balanced braces)
      while (i < n) {
        const d = src[i];
        if (brace === 0 && d === "\\") { raw += d + (src[i + 1] ?? ""); i += 2; continue; }   // keep escapes raw so \` / \${ don't terminate/interpolate
        if (brace === 0 && d === "`") { i++; break; }                       // end of template
        if (brace === 0 && d === "$" && src[i + 1] === "{") { brace = 1; raw += "${"; i += 2; continue; }
        if (brace > 0) {
          if (d === '"') {   // skip a string literal so its braces/backticks don't confuse balancing
            raw += d; i++;
            while (i < n && src[i] !== '"') { if (src[i] === "\\") { raw += src[i] + (src[i + 1] ?? ""); i += 2; continue; } raw += src[i]; i++; }
            raw += src[i] ?? ""; i++; continue;
          }
          if (d === "{") brace++;
          else if (d === "}") brace--;
          raw += d; i++; continue;
        }
        raw += d; i++;   // literal char (escapes kept raw; the parser unescapes)
      }
      toks.push({ t: "tmpl", v: raw, pos: i });
      continue;
    }
    if (c === "'") {   // char literal -> codepoint (UTF-32). 'a' / '\n' / 'あ'
      i++;
      let cp: number;
      if (src[i] === "\\") {
        const e = src[i + 1];
        const esc: Record<string, number> = { n: 10, t: 9, r: 13, "0": 0, "'": 39, '"': 34, "\\": 92 };
        cp = e in esc ? esc[e] : (e.codePointAt(0) ?? 0);
        i += 2;
      } else {
        cp = src.codePointAt(i) ?? 0;
        i += String.fromCodePoint(cp).length;   // advance past a possible surrogate pair
      }
      if (src[i] !== "'") throw new Error(`lex error: unterminated char literal at ${i}`);
      i++;
      toks.push({ t: "char", v: String(cp), pos: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9_]/.test(src[j])) j++;
      let flt = false;
      if (src[j] === "." && /[0-9]/.test(src[j + 1])) { flt = true; j++; while (j < n && /[0-9_]/.test(src[j])) j++; }
      if (src[j] === "e" || src[j] === "E") { flt = true; j++; if (src[j] === "+" || src[j] === "-") j++; while (j < n && /[0-9]/.test(src[j])) j++; }
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
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "=>" || two === "??" ||
        two === "&&" || two === "||" ||
        two === "+%" || two === "-%" || two === "*%" || two === "+|" || two === "-|" || two === "*|") {
      toks.push({ t: two, v: two, pos: i }); i += 2; continue;
    }
    if ("(){}[];:,.=+-*/%<>&?!".includes(c)) { toks.push({ t: c, v: c, pos: i }); i++; continue; }
    throw new Error(`lex error: unexpected '${c}' at ${i}`);
  }
  toks.push({ t: "eof", v: "", pos: n });
  return toks;
}
