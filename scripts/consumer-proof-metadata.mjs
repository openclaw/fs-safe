import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export function packageProofSource(cwd = process.cwd()) {
  try {
    const git = (args) => execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 10_000, stdio: "pipe",
    }).trim();
    const [commit, tree] = git(["rev-parse", "HEAD", "HEAD^{tree}"]).split(/\r?\n/);
    return { commit, tree, dirty: git(["status", "--porcelain"]) !== "" };
  } catch (error) {
    // Source archives and minimal build containers need not have Git metadata.
    return { unavailable: error.code === "ENOENT" ? "git-not-installed" : "git-metadata-unavailable" };
  }
}

export function nativeBinaryLoaded(binary, sharedObjects = process.report.getReport().sharedObjects) {
  // The native resolver accepts Windows loader namespace paths without walking "C:".
  const expected = realpathSync.native(binary);
  return sharedObjects.filter((file) => file.endsWith(".node"))
    .some((file) => realpathSync.native(file) === expected);
}

const windowsFixtureSteps = new Set([
  "script:start", "add-type:start", "add-type:end", "get-acl:start", "get-acl:end",
  "set-acl:start", "set-acl:end", "raw-security:start", "raw-security:end", "output:start", "output:end",
]);

export function windowsSecurityFixturePhases(stderr) {
  if (typeof stderr !== "string") return [];
  const phases = [];
  const markers = /^FS_SAFE_SECURITY_FIXTURE:([a-z-]+:(?:start|end)):(\d{1,9})\r?$/gm;
  for (const match of stderr.slice(0, 1024 * 1024).matchAll(markers)) {
    if (!windowsFixtureSteps.has(match[1])) continue;
    phases.push({ step: match[1], childElapsedMs: Number(match[2]) });
    if (phases.length === 16) break;
  }
  return phases;
}
