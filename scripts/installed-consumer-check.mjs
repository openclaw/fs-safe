import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { officialCompiler, runProcess } from "./compiler-qualification.mjs";

const repository = resolve(import.meta.dirname, "..");
const consumer = resolve(process.argv[2]);
const require = createRequire(import.meta.url);
const official = officialCompiler(repository);
const compilers = { official: official.executable };
if (process.argv[3]) compilers.candidate = resolve(process.argv[3]);
const fixtures = ["root-overloads.mts", "state-and-locks.mts", "lifetimes-and-results.mts"];
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("TSC_TS_") || ["GOGC", "GOMEMLIMIT", "GOMAXPROCS", "GODEBUG"].includes(key)) delete env[key];
}
env.TSC_TS_LIB_DIR = official.library;

// All package imports resolve from the installed tarball. Never use src/ aliases:
// a successful repository typecheck does not qualify published declarations.
const installed = JSON.parse(readFileSync(join(consumer, "node_modules/@openclaw/fs-safe/package.json"), "utf8"));
if (installed.name !== "@openclaw/fs-safe") throw new Error("expected installed fs-safe package");
for (const fixture of fixtures) {
  copyFileSync(join(repository, "test/fixtures/installed-consumer", fixture), join(consumer, fixture));
}
const config = join(consumer, "installed-consumer-tsconfig.json");
const compilerOptions = {
  strict: true, noEmit: true, skipLibCheck: false,
  target: "ES2022", lib: ["ES2023", "ESNext.Disposable"],
  module: "NodeNext", moduleResolution: "NodeNext", verbatimModuleSyntax: true,
  types: ["node"], typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
};
writeFileSync(config, JSON.stringify({ compilerOptions, files: fixtures }, null, 2));

// A compiler that silently ignores expect-error directives could accept every
// negative fixture. Require its unused-directive diagnostic before trusting them.
writeFileSync(join(consumer, "unused-expect-error.mts"), "// @ts-expect-error deliberately unused\nexport const valid: string = 'ok';\n");
const sentinel = join(consumer, "unused-expect-error-tsconfig.json");
writeFileSync(sentinel, JSON.stringify({ compilerOptions, files: ["unused-expect-error.mts"] }, null, 2));
for (const [label, compiler] of Object.entries(compilers)) {
  const invoke = (file, extra = []) => runProcess(compiler, ["-p", file, "--pretty", "false", ...extra], { cwd: consumer, env });
  const rejected = invoke(sentinel);
  // TypeScript's noEmit diagnostic result is outputs-skipped (1), not emitted (2).
  if (rejected.status !== 1 || !/^unused-expect-error\.mts\(1,1\): error TS2578: Unused '@ts-expect-error' directive\.[\r\n]*$/.test(rejected.stdout) || rejected.stderr) {
    throw new Error(`${label}: unused-directive control failed (exit ${rejected.status})\n${rejected.stdout}${rejected.stderr}`);
  }
  for (const extra of [[], ["--exactOptionalPropertyTypes"]]) {
    const result = invoke(config, extra);
    if (result.status !== 0 || result.stdout || result.stderr) {
      throw new Error(`${label}: installed declarations failed ${extra.join(" ")}\n${result.stdout}${result.stderr}`);
    }
  }
  console.log(`${label}: installed overloads, stores, locks, disposal and result narrowing passed (strict + exact optional)`);
}
