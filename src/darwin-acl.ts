import { FsSafeError } from "./errors.js";
import type { NativeDarwinAclFacts } from "./native-binding.js";
import { getNativeBinding } from "./native.js";

/** Internal descriptor facts only; callers own identity, lifetime, and ACL policy. */
export function inspectDarwinAcl(fd: number): NativeDarwinAclFacts {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) {
    throw new FsSafeError("permission-unverified", "Darwin ACL inspection requires a valid descriptor");
  }
  const native = getNativeBinding();
  if (typeof native?.inspectDarwinAcl !== "function") {
    throw new FsSafeError("helper-unavailable", "Darwin ACL inspection requires the matching native capability");
  }
  let facts: unknown;
  try {
    facts = native.inspectDarwinAcl(fd);
  } catch (cause) {
    throw new FsSafeError("permission-unverified", "Darwin descriptor ACL could not be inspected", { cause });
  }
  const state = facts && typeof facts === "object" && "state" in facts ? facts.state : undefined;
  if (state !== "absent" && state !== "empty" && state !== "present") {
    throw new FsSafeError("permission-unverified", "Darwin ACL inspection returned invalid facts");
  }
  return { state };
}
