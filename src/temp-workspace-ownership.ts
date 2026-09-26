import fs from "node:fs";

type DirectoryOwner = { uid: number | bigint; gid: number | bigint };
type UnmappedOwner = { uid: number; gid: number };
export type TempWorkspaceOwnership = "user" | "root" | "unmapped" | "foreign";

let unmappedOwner: UnmappedOwner | null | undefined;
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

function namespaceOwner(): UnmappedOwner | null {
  if (unmappedOwner !== undefined) return unmappedOwner;
  unmappedOwner = null;
  if (process.platform !== "linux") return unmappedOwner;
  try {
    const mappings = fs.readFileSync("/proc/self/uid_map", "utf8").trim()
      .split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    if (!mappings.every((row) => row.length === 3 && row.every((id) =>
      Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff) && row[2]! > 0)) {
      return unmappedOwner;
    }
    if (mappings.length === 1 && mappings[0]![0] === 0 &&
      mappings[0]![1] === 0 && mappings[0]![2] === 0xffffffff) return unmappedOwner;
    const uid = overflowId("uid");
    // An explicitly mapped overflow-number UID is a real owner, not an unmapped one.
    if (mappings.some(([start, , count]) => uid >= start! && uid < start! + count!)) {
      return unmappedOwner;
    }
    unmappedOwner = { uid, gid: overflowId("gid") };
  } catch {
    // Without namespace evidence, preserve ordinary ownership admission.
  }
  return unmappedOwner;
}

export function classifyTempWorkspaceOwner(stat: DirectoryOwner, uid: number): TempWorkspaceOwnership {
  if (stat.uid === uid || stat.uid === BigInt(uid)) return "user";
  if (stat.uid === 0 || stat.uid === 0n) return "root";
  const unmapped = namespaceOwner();
  return unmapped && (stat.uid === unmapped.uid || stat.uid === BigInt(unmapped.uid)) &&
    (stat.gid === unmapped.gid || stat.gid === BigInt(unmapped.gid))
    ? "unmapped"
    : "foreign";
}

export function warnUnmappedTempWorkspaceAncestor(): void {
  if (warned) return;
  warned = true;
  process.emitWarning(
    "Temp workspace ancestor ownership is unverifiable in this user namespace; trusting the host directory hierarchy while enforcing ancestor modes and a process-owned private root.",
    { code: "FS_SAFE_UNMAPPED_TEMP_ANCESTOR", type: "FsSafeWarning" },
  );
}
