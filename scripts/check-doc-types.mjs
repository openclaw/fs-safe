import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = await fs.mkdtemp(path.join(repoRoot, ".docs-types-"));
try {
  // Supply only the application context omitted by the README's excerpts.
  await fs.writeFile(path.join(directory, "context.d.ts"), `
import type { Root } from "@openclaw/fs-safe";
declare global {
  const fs: Root;
  const path: typeof import("node:path");
  const root: string;
  const input: string;
  const uploadPath: string;
  const targetPath: string;
  const state: { enabled: boolean };
  const download: { saveAs(filePath: string): Promise<void> };
}
`);
  let count = 0;
  for (const file of ["README.md", "docs/sidecar-lock.md"]) {
    const markdown = await fs.readFile(path.join(repoRoot, file), "utf8");
    let selected = 0;
    for (const block of markdown.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/gu)) {
      if (file !== "README.md" && !block[1].includes("shouldReclaim:")) continue;
      const line = markdown.slice(0, block.index).split("\n").length + 1;
      const name = `${path.basename(file, ".md")}-line-${line}.mts`;
      await fs.writeFile(path.join(directory, name), `export {};\n${block[1]}`);
      selected += 1;
    }
    if (selected === 0) throw new Error(`${file} has no selected TypeScript examples`);
    count += selected;
  }
  await fs.writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2023", "ESNext.Disposable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["*.mts", "context.d.ts"],
  }));
  const manifestPath = require.resolve("typescript/package.json");
  const manifest = require(manifestPath);
  const result = spawnSync(process.execPath, [
    path.resolve(path.dirname(manifestPath), manifest.bin.tsc),
    "--project", path.join(directory, "tsconfig.json"), "--pretty", "false",
  ], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("TypeScript examples do not match the built declarations");
  console.log(`compiled ${count} TypeScript examples against the built declarations`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
