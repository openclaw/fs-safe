import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkSdk(repositoryRoot, run = spawnSync) {
  const sdkFile = path.join(repositoryRoot, "global.json");
  let manifest;
  try { manifest = readFileSync(sdkFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { available: false };
    throw error;
  }
  const expected = JSON.parse(manifest).sdk.version;
  const actual = run("dotnet", ["--version"], {
    cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  return { available: true, sdkFile, installed: actual.status === 0 && actual.stdout.trim() === expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkSdk(fileURLToPath(new URL("../../../", import.meta.url)));
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `available=${result.available}`,
    `installed=${result.installed ?? false}`,
    `sdk_file=${result.sdkFile ?? ""}`,
    "",
  ].join("\n"));
}
