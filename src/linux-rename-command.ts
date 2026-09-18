import { spawnSync } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";

type Identity = Pick<BigIntStats, "dev" | "ino">;
type Parent = { parentFd: number; basename: string; parentIdentity: Identity };
export type LinuxRenameNoReplaceInput = {
  source: Parent & { identity: Identity; links: bigint; fd?: number };
  target: Parent;
};

// Isolated Python imports only its installed standard library. Names travel as
// Node's exact UTF-8 bytes; no paths or user text are interpolated into code.
const RENAME_PROGRAM = String.raw`import base64,errno,json,os,stat,sys
def emit(value):
 sys.stdout.write(json.dumps(value,separators=(',',':'))+'\n')
def exact(value):
 if not isinstance(value,str) or not value.isascii() or not value.isdecimal(): raise ValueError()
 return int(value,10)
def name(value):
 if not isinstance(value,str): raise ValueError()
 value=base64.b64decode(value,validate=True)
 if not value or value in (b'.',b'..') or b'/' in value or b'\0' in value: raise ValueError()
 return value
def check(observed,expected,kind,links=None):
 if observed.st_dev!=exact(expected['dev']) or observed.st_ino!=exact(expected['ino']) or not kind(observed.st_mode) or (links is not None and observed.st_nlink!=links): raise ValueError()
try:
 import ctypes
 libc=ctypes.CDLL(None,use_errno=True)
 rename=libc.renameat2
 rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
 rename.restype=ctypes.c_int
except (ImportError,AttributeError,OSError):
 emit({'phase':'prepare','error':'unavailable'})
 sys.exit(0)
try:
 raw=sys.stdin.buffer.read(65537)
 if len(raw)>65536: raise ValueError()
 value=json.loads(raw)
 source=name(value['sourceName']); target=name(value['targetName']); links=exact(value['links'])
 if links<1: raise ValueError()
 check(os.fstat(3),value['sourceParent'],stat.S_ISDIR)
 check(os.fstat(4),value['targetParent'],stat.S_ISDIR)
 check(os.stat(source,dir_fd=3,follow_symlinks=False),value['source'],stat.S_ISREG,links)
 if value['sourcePinned']: check(os.fstat(5),value['source'],stat.S_ISREG,links)
except (ValueError,TypeError,KeyError,OSError):
 emit({'phase':'prepare','error':'path-mismatch'})
 sys.exit(0)
result=rename(3,source,4,target,1)
error=ctypes.get_errno() if result!=0 else 0
emit({'phase':'rename','result':result,'errno':error,'code':errno.errorcode.get(error) if error else None})`;

function failure(code: "helper-unavailable" | "helper-failed" | "path-mismatch" | "already-exists", commit: "not-attempted" | "unknown", cause?: unknown): FsSafeError {
  return new FsSafeError(code, "Linux atomic no-replace rename could not complete", { cause, details: { commit } });
}

export function renameLinuxNoReplaceSync(input: LinuxRenameNoReplaceInput): void {
  const identity = (value: Identity) => ({ dev: value.dev.toString(), ino: value.ino.toString() });
  const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-X", "utf8", "-c", RENAME_PROGRAM], {
    input: JSON.stringify({
      sourceName: Buffer.from(input.source.basename, "utf8").toString("base64"),
      targetName: Buffer.from(input.target.basename, "utf8").toString("base64"),
      sourceParent: identity(input.source.parentIdentity), targetParent: identity(input.target.parentIdentity),
      source: identity(input.source.identity), links: input.source.links.toString(), sourcePinned: input.source.fd !== undefined,
    }),
    encoding: "utf8", cwd: "/", env: { LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe", input.source.parentFd, input.target.parentFd, ...(input.source.fd === undefined ? [] : [input.source.fd])],
  });
  // Resource failures can prevent spawning just as executable admission can.
  // Never infer that from an error code once a process could have started.
  const spawnCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (result.pid === 0 && result.status === null && result.signal === null && result.error) {
    const code = ["ENOENT", "EACCES", "ENOEXEC"].includes(spawnCode ?? "") ? "helper-unavailable" : "helper-failed";
    throw failure(code, "not-attempted", result.error);
  }
  if (result.error || result.status !== 0 || result.signal || result.stderr) {
    throw failure("helper-failed", "unknown", result.error);
  }
  let reply: unknown;
  try { reply = JSON.parse(result.stdout); } catch (error) { throw failure("helper-failed", "unknown", error); }
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw failure("helper-failed", "unknown");
  const response = reply as Record<string, unknown>;
  if (response.phase === "prepare" && Object.keys(response).length === 2 && response.error === "unavailable") throw failure("helper-unavailable", "not-attempted");
  if (response.phase === "prepare" && Object.keys(response).length === 2 && response.error === "path-mismatch") throw failure("path-mismatch", "not-attempted");
  if (response.phase !== "rename" || Object.keys(response).length !== 4) throw failure("helper-failed", "unknown");
  if (response.result === 0 && response.errno === 0 && response.code === null) return;
  if (response.result !== -1 || typeof response.errno !== "number" || !Number.isSafeInteger(response.errno) ||
    response.errno < 1 || response.errno > 0x7fff_ffff || typeof response.code !== "string" || !/^E[A-Z0-9]+$/.test(response.code)) {
    throw failure("helper-failed", "unknown");
  }
  const cause = Object.assign(new Error(`renameat2 failed (${response.code})`), { code: response.code, errno: -response.errno, syscall: "renameat2" });
  // An ordinary errno can follow a committed remote rename whose reply was lost.
  if (response.code === "EEXIST" || response.code === "ENOTEMPTY") throw failure("already-exists", "unknown", cause);
  if (["ENOSYS", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(response.code)) throw failure("helper-unavailable", "unknown", cause);
  throw failure("helper-failed", "unknown", cause);
}
