import { spawnSync } from "node:child_process";
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

function commandFailure(cause?: unknown): FsSafeError {
  return new FsSafeError("helper-failed", "macOS atomic move command did not provide a complete result", { cause });
}

export function renameDarwinNoReplace(input: DarwinRenameNoReplaceInput): void {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", RENAME_PROGRAM], {
    input: JSON.stringify({ sourceName: input.source.basename, targetName: input.target.basename }),
    encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe", input.source.parentFd, input.target.parentFd],
  });
  // A timeout, missing reply or abnormal exit may follow a completed rename.
  // The caller preserves both names and never retries or rolls back this route.
  if (result.error || result.status !== 0 || result.signal || result.stderr) {
    throw commandFailure(result.error ?? new Error("macOS move command exited abnormally"));
  }
  let reply: unknown;
  try { reply = JSON.parse(result.stdout); } catch (error) { throw commandFailure(error); }
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || !("result" in reply) || !("errno" in reply)) throw commandFailure();
  if (reply.result === 0 && reply.errno === 0) return;
  if (reply.result !== -1 || typeof reply.errno !== "number" || !Number.isSafeInteger(reply.errno) || reply.errno < 1 || reply.errno > 0x7fff_ffff) throw commandFailure();
  const code = getSystemErrorName(-reply.errno);
  if (!/^E[A-Z0-9]+$/.test(code)) throw commandFailure();
  throw Object.assign(new Error(`atomic no-replace move failed (${code})`), { code, errno: -reply.errno, syscall: "renameatx_np" });
}
