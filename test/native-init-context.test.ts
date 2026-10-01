import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadTestNative } from "./helpers/native-probe.js";

const hasNative = Boolean(loadTestNative("optional"));

it.runIf(hasNative)("does not retain the first native caller's async context", () => {
  const output = execFileSync(process.execPath, [
    "--expose-gc",
    fileURLToPath(new URL("./fixtures/native-init-context.mjs", import.meta.url)),
  ], { encoding: "utf8", timeout: 20_000 });
  expect(output).toContain("caller contexts preserved and collected");
}, 25_000);
