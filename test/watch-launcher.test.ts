import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("supports the runtime ESM launcher without clearing inherited flags", async () => {
  const entry = new URL("../dist/watch.js", import.meta.url).href;
  const root = new URL("../dist/root.js", import.meta.url).href;
  const script = [
    "import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';",
    "const {watch}=await import(" + JSON.stringify(entry) + ");",
    "const {root}=await import(" + JSON.stringify(root) + ");",
    "const directory=await fs.mkdtemp(path.join(os.tmpdir(),'fs-watch-launcher-')); let owner;",
    "try { owner=watch(await root(directory),{scopes:[{path:'',kind:'tree'}],onDirty(){}}); await owner.ready; console.log('ready'); }",
    "finally { try { await owner?.close(); } finally { await fs.rm(directory,{recursive:true,force:true}); } }",
  ].join("\n");
  // Bun evaluates ESM by default and does not need Node’s input-type switch.
  const args = process.versions.bun ? ["--eval", script] : ["--input-type=module", "--eval", script];
  const result = await promisify(execFile)(process.execPath, args, { timeout: 5000 });
  expect(result.stdout.trim()).toBe("ready");
});
