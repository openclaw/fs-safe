import fs from "node:fs";

type DirectoryOwner = { uid: number | bigint; gid: number | bigint };
export type TempWorkspaceOwnership = "user" | "root" | "unmapped" | "foreign";

let warned = false;

function overflowId(kind: "uid" | "gid"): number {
  try {
    const value = Number(fs.readFileSync(`/proc/sys/kernel/overflow${kind}`, "utf8").trim());
    if (Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff) return value;
  } catch {
    // Linux defaults when the sysctl files are unavailable in the service mount.
  }
  return 65534;
}

function unmappedId(kind: "uid" | "gid"): number | null {
  const mappings = fs.readFileSync(`/proc/self/${kind}_map`, "utf8").trim()
    .split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  if (!mappings.every((row) => row.length === 3 && row.every((id) =>
    Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff) && row[2]! > 0)) return null;
  if (mappings.length === 1 && mappings[0]![0] === 0 &&
    mappings[0]![1] === 0 && mappings[0]![2] === 0xffffffff) return null;
  const id = overflowId(kind);
  // Recheck every admission: an explicitly mapped overflow-number ID is real ownership.
  return mappings.some(([start, , count]) => id >= start! && id < start! + count!) ? null : id;
}

export function classifyTempWorkspaceOwner(stat: DirectoryOwner, uid: number): TempWorkspaceOwnership {
  if (stat.uid === uid || stat.uid === BigInt(uid)) return "user";
  if (stat.uid === 0 || stat.uid === 0n) return "root";
  if (process.platform !== "linux") return "foreign";
  try {
    const overflowUid = unmappedId("uid");
    const overflowGid = unmappedId("gid");
    return overflowUid !== null && overflowGid !== null &&
      (stat.uid === overflowUid || stat.uid === BigInt(overflowUid)) &&
      (stat.gid === overflowGid || stat.gid === BigInt(overflowGid))
      ? "unmapped"
      : "foreign";
  } catch {
    // Unavailable mapping evidence cannot authorize the namespace exception.
    return "foreign";
  }
}

export function warnUnmappedTempWorkspaceAncestor(): void {
  if (warned) return;
  warned = true;
  process.emitWarning(
    "Temp workspace ancestor ownership is unverifiable in this user namespace; trusting the host directory hierarchy while enforcing ancestor modes and a process-owned private root.",
    { code: "FS_SAFE_UNMAPPED_TEMP_ANCESTOR", type: "FsSafeWarning" },
  );
}
