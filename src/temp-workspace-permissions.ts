import type { BigIntStats, Stats } from "node:fs";
import { FsSafeError } from "./errors.js";

export function validateTempWorkspaceDirMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new FsSafeError("insecure-permissions", "temp workspace dirMode must be permission bits");
  }
  if (process.platform !== "win32" && (mode & 0o022) !== 0) {
    throw new FsSafeError("insecure-permissions", "temp workspace must not be group/world writable");
  }
}

export function assertTrustedTempWorkspaceDirectory(
  stat: Pick<BigIntStats, "uid" | "mode"> | Pick<Stats, "uid" | "mode">,
  uid: number | undefined,
  child = false,
): void {
  if (uid === undefined) return;
  const ownedByUser = typeof stat.uid === "bigint" ? stat.uid === BigInt(uid) : stat.uid === uid;
  const ownedByRoot = typeof stat.uid === "bigint" ? stat.uid === 0n : stat.uid === 0;
  if (!ownedByUser && (child || !ownedByRoot)) {
    throw new FsSafeError("not-owned", "temp workspace directory has an untrusted owner");
  }
  // A root/current-user-owned sticky directory protects children owned by us,
  // including the usual shared system temp directory. Never chmod that parent.
  const writable = typeof stat.mode === "bigint"
    ? (stat.mode & 0o022n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o022) !== 0;
  const sticky = typeof stat.mode === "bigint"
    ? (stat.mode & 0o1000n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o1000) !== 0;
  if (typeof stat.mode !== "bigint" && (!Number.isSafeInteger(stat.mode) || stat.mode < 0)) {
    throw new FsSafeError("insecure-permissions", "temp workspace directory permissions are invalid");
  }
  if (writable && (child || !sticky)) {
    throw new FsSafeError(
      "insecure-permissions",
      "temp workspace directory is group/world writable without sticky protection",
    );
  }
}
