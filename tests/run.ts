// Golden test runner: build each tests/cases/<name>.moz, feed <name>.in (if any),
// compare stdout to <name>.out. Exit nonzero if any case fails.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const casesDir = join(here, "cases");
const compiler = join(root, "src", "main.ts");

const cases = readdirSync(casesDir).filter((f) => f.endsWith(".mzc")).sort();
let pass = 0, fail = 0;

for (const f of cases) {
  const name = f.replace(/\.mzc$/, "");
  const moz = join(casesDir, f);
  const input = existsSync(join(casesDir, name + ".in")) ? readFileSync(join(casesDir, name + ".in"), "utf8") : "";
  const expected = existsSync(join(casesDir, name + ".out")) ? readFileSync(join(casesDir, name + ".out"), "utf8") : "";
  try {
    execFileSync("node", ["--disable-warning=ExperimentalWarning", compiler, "build", moz], { stdio: "pipe" });
    const got = execFileSync(join(root, "build", name), [], { input, encoding: "utf8" });
    if (got === expected) { console.log(`PASS ${name}`); pass++; }
    else { console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(got)}`); fail++; }
  } catch (e) {
    console.log(`FAIL ${name} (${String((e as Error).message).split("\n")[0]})`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
