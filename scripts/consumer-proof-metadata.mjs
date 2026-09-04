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
