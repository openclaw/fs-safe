import fs from "node:fs";
import { getNativeBinding } from "./native.js";

export type DarwinAclInspection =
  | { kind: "none" }
  | { kind: "present"; inheritsToFiles: boolean; inheritsToDirectories: boolean }
  | { kind: "unknown"; reason: string };

/** Inspect one no-follow descriptor. Unknown is never evidence of no ACL. */
export function inspectDarwinAcl(path: string): DarwinAclInspection {
  if (process.platform !== "darwin") return { kind: "unknown", reason: "unsupported-platform" };
  let fd: number | undefined;
  try {
    const native = getNativeBinding();
    if (!native?.inspectDarwinAcl) return { kind: "unknown", reason: "helper-unavailable" };
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const facts = native.inspectDarwinAcl(fd);
    if (facts.state === "absent" || facts.state === "empty") return { kind: "none" };
    if (facts.state === "present" && typeof facts.inheritsToFiles === "boolean" &&
      typeof facts.inheritsToDirectories === "boolean") {
      return { kind: "present", inheritsToFiles: facts.inheritsToFiles, inheritsToDirectories: facts.inheritsToDirectories };
    }
    return { kind: "unknown", reason: "incomplete-acl-facts" };
  } catch (error) {
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
