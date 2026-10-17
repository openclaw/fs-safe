import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { officialCompiler, runProcess } from "../scripts/compiler-qualification.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const repository = path.resolve(import.meta.dirname, "..");

it("checks an aliased consumer directory and rejects a weakened installed declaration", async () => {
  const temporary = await tempRoot("installed-consumer-");
  const consumer = path.join(temporary, "consumer");
  const installed = path.join(consumer, "node_modules/@openclaw/fs-safe");
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(repository, "package.json"), path.join(installed, "package.json"));
  fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const emitted = runProcess(officialCompiler(repository).executable, [
    "-p", path.join(repository, "tsconfig.json"), "--emitDeclarationOnly",
    "--outDir", path.join(installed, "dist"), "--pretty", "false",
  ], { cwd: repository });
  expect(emitted.status, emitted.stdout + emitted.stderr).toBe(0);

  const alias = path.join(temporary, "consumer alias");
  fs.symlinkSync(consumer, alias, process.platform === "win32" ? "junction" : "dir");
  const check = () => runProcess(process.execPath, [
    path.join(repository, "scripts/installed-consumer-check.mjs"), alias,
  ], { cwd: alias });
  const valid = check();
  expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  expect(valid.stdout).toContain("passed (strict + exact optional)");

  // Only the disposable declaration copy is weakened: open() must not acquire
  // readBytes()'s maxBytes option without tripping the negative consumer case.
  const declaration = path.join(installed, "dist/root-options.d.ts");
  const original = fs.readFileSync(declaration, "utf8");
  const signature = 'export type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;';
  expect(original).toContain(signature);
  fs.writeFileSync(declaration, original.replace(signature, "export type RootOpenOptions = RootReadOptions;"));
  const weakened = check();
  expect(weakened.status).toBe(1);
  expect(weakened.stderr).toContain("official: installed declarations failed");
  expect(weakened.stderr).toMatch(/root-overloads\.mts\(\d+,\d+\): error TS2578: Unused '@ts-expect-error' directive\./);
}, 15_000);
