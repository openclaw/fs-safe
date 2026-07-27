import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, root } from "../dist/index.js";
import { sha256File } from "../dist/file-hash.js";

const mode = process.argv[2];
if (!new Set(["auto", "require", "off"]).has(mode)) {
  throw new Error("usage: native-mode-smoke.mjs <auto|require|off>");
}
configureFsSafeNative({ mode });
if (mode !== "off") {
  const fixture = path.join(os.tmpdir(), `fs-safe-native-mode-${process.pid}`);
  await fs.writeFile(fixture, "native");
  try {
    await sha256File(fixture);
  } finally {
    await fs.rm(fixture, { force: true });
  }
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), `fs-safe-mode-${mode}-`));
try {
  const capability = await root(directory);
  await capability.create("value.txt", mode);
  const value = await capability.readText("value.txt");
  if (value !== mode) throw new Error("mode smoke content mismatch");
  console.log(JSON.stringify({ mode, bindingExpected: mode !== "off", result: "PASS" }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
