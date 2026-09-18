import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { getSystemErrorName } from "node:util";
import { FsSafeError } from "./errors.js";

export type DarwinRenameNoReplaceInput = {
  source: { parentFd: number; basename: string };
  target: { parentFd: number; basename: string };
};

// Darwin's O_EVTONLY still requires content permission. The stock JXA host can
// use renameatx_np with inherited directory descriptors without opening data.
const RENAME_PROGRAM = String.raw`ObjC.import("Foundation");
ObjC.bindFunction("renameatx_np", ["int", ["int", "char *", "int", "char *", "unsigned int"]]);
ObjC.bindFunction("__error", ["int *", []]);
var data=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
var input=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)));
function childName(value) {
  if(typeof value!=="string" || !value || value==="." || value===".." || value.indexOf("/")!==-1 || value.indexOf("\u0000")!==-1) throw Error("invalid move basename");
  return value;
}
// RENAME_EXCL is 0x00000004 in Darwin sys/stdio.h.
var result=$.renameatx_np(3,childName(input.sourceName),4,childName(input.targetName),4);
JSON.stringify({result:result,errno:result===0?0:$.__error()[0]});`;

function commandFailure(
  code: "helper-unavailable" | "helper-failed" | "already-exists",
  commit: "not-attempted" | "unknown",
  cause?: unknown,
): FsSafeError {
  return new FsSafeError(code, "macOS atomic no-replace rename could not complete", { cause, details: { commit } });
}

export function renameDarwinNoReplace(input: DarwinRenameNoReplaceInput): void {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", RENAME_PROGRAM], {
    // Match Node's filesystem UTF-8 encoding of unpaired UTF-16 surrogates.
    input: JSON.stringify({
      sourceName: Buffer.from(input.source.basename, "utf8").toString("utf8"),
      targetName: Buffer.from(input.target.basename, "utf8").toString("utf8"),
    }),
    encoding: "utf8", cwd: "/", env: { LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe", input.source.parentFd, input.target.parentFd],
  });
  // Resource failures can prevent spawning just as executable admission can.
  // Never infer that from an error code once a process could have started.
  const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.pid === 0 && result.status === null && result.signal === null && result.error) {
    const code = ["ENOENT", "EACCES", "ENOEXEC"].includes(spawnCode ?? "") ? "helper-unavailable" : "helper-failed";
    throw commandFailure(code, "not-attempted", result.error);
  }
  if (result.error || result.status !== 0 || result.signal || result.stderr) {
    throw commandFailure("helper-failed", "unknown", result.error);
  }
  let reply: unknown;
  try { reply = JSON.parse(result.stdout); } catch (error) { throw commandFailure("helper-failed", "unknown", error); }
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || Object.keys(reply).length !== 2 ||
    !("result" in reply) || !("errno" in reply)) throw commandFailure("helper-failed", "unknown");
  if (reply.result === 0 && reply.errno === 0) return;
  if (reply.result !== -1 || typeof reply.errno !== "number" || !Number.isSafeInteger(reply.errno) ||
    reply.errno < 1 || reply.errno > 0x7fff_ffff) throw commandFailure("helper-failed", "unknown");
  let code = getSystemErrorName(-reply.errno);
  // libuv does not name Darwin's distinct EOPNOTSUPP (102); Node exposes it.
  if (!/^E[A-Z0-9]+$/.test(code) && reply.errno === constants.errno.EOPNOTSUPP) code = "EOPNOTSUPP";
  if (!/^E[A-Z0-9]+$/.test(code)) throw commandFailure("helper-failed", "unknown");
  const cause = Object.assign(new Error(`renameatx_np failed (${code})`), { code, errno: -reply.errno, syscall: "renameatx_np" });
  // An ordinary errno can follow a committed remote rename whose reply was lost.
  if (code === "EEXIST" || code === "ENOTEMPTY") throw commandFailure("already-exists", "unknown", cause);
  if (["ENOSYS", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)) throw commandFailure("helper-unavailable", "unknown", cause);
  throw commandFailure("helper-failed", "unknown", cause);
}
