import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { packageProofSource } from "../scripts/consumer-proof-metadata.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let directory: string;
beforeEach(async () => {
  directory = await tempRoot("fs-safe-dry-run-provenance-");
  await fs.copyFile(".gitignore", path.join(directory, ".gitignore"));
  await fs.writeFile(path.join(directory, "source.txt"), "original source\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git(["init", "--quiet"]);
  git(["add", ".gitignore", "source.txt"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "fixture"]);
}, 30_000);

it.each(["\n", "\r\n"])("preserves dry-run provenance and detects source edits with %j line endings", async (newline) => {
  const workflow = (await fs.readFile(".github/workflows/release.yml", "utf8")).replace(/\r?\n/g, newline);
  const collect = workflow.split(/\r?\n  collect-dry-run:\r?\n/)[1]?.split(/\r?\n  draft-release:\r?\n/)[0];
  const output = collect?.match(/pnpm package:smoke --output ([^\s]+)/)?.[1];
  expect(output).toBeDefined();
  const source = packageProofSource(directory);
  expect(source.dirty).toBe(false);

  const artifacts = path.join(directory, output!);
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, "synthetic-package.tgz"), "synthetic package bytes");
  await fs.writeFile(path.join(artifacts, "manifest.json"), "[]\n");
  expect(packageProofSource(directory)).toEqual(source);

  await fs.writeFile(path.join(directory, "source.txt"), "changed source\n");
  expect(packageProofSource(directory)).toEqual({ ...source, dirty: true });
});
