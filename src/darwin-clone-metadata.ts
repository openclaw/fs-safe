import { execFile } from "node:child_process";
import { FsSafeError } from "./errors.js";

const MAX_BATCH_PATHS = 128;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const DARWIN_PATH_MAX = 1024;

// The same attrlist, zeroed result, and NOFOLLOW | ATTR_CMN_EXTENDED flags as
// native/src/clone_metadata.rs. Base64 keeps the packed uint64 fields lossless.
const PROGRAM = String.raw`ObjC.import("Foundation");
ObjC.bindFunction("getattrlist", ["int", ["char *", "void *", "void *", "unsigned long", "unsigned long"]]);
var data=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
var paths=JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data,$.NSUTF8StringEncoding)));
if(!Array.isArray(paths)||paths.length>128)throw Error("invalid metadata batch");
var attributes=$.NSData.alloc.initWithBase64EncodedStringOptions("BQAAAAqMA4IAAAAAAAAAAAACAAAAAQAA",0);
var results=paths.map(function(pathname){
  if(typeof pathname!=="string"||pathname.charAt(0)!=="/"||pathname.indexOf("\u0000")!==-1)throw Error("invalid metadata path");
  var output=$.NSMutableData.dataWithLength(100);
  var result=$.getattrlist(pathname,attributes.bytes,output.mutableBytes,100,0x21);
  if(result===-1)return null;
  if(result!==0)throw Error("invalid metadata syscall result");
  return ObjC.unwrap(output.base64EncodedStringWithOptions(0));
});
JSON.stringify({version:1,results:results});`;

function commandFailure(cause?: unknown): FsSafeError {
  return new FsSafeError("helper-failed", "macOS clone metadata command did not provide a complete result", { cause });
}

function parseReply(stdout: string, count: number): (Buffer | null)[] {
  let reply: unknown;
  try { reply = JSON.parse(stdout); } catch (cause) { throw commandFailure(cause); }
  if (!reply || typeof reply !== "object" || Array.isArray(reply) ||
      Object.keys(reply).length !== 2 || !("version" in reply) || reply.version !== 1 ||
      !("results" in reply) || !Array.isArray(reply.results) || reply.results.length !== count) {
    throw commandFailure();
  }
  return reply.results.map((value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "string" || value.length !== 136) throw commandFailure();
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 100 || bytes.toString("base64") !== value) throw commandFailure();
    return bytes;
  });
}

function inspectBatch(paths: readonly string[]): Promise<(Buffer | null)[]> {
  return new Promise((resolve, reject) => {
    let inputError: unknown;
    try {
      const child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", PROGRAM], {
        encoding: "utf8", cwd: "/", timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      }, (error, stdout, stderr) => {
        if (error || inputError || stderr) {
          reject(commandFailure(error ?? inputError ?? new Error("unexpected metadata command diagnostics")));
          return;
        }
        try { resolve(parseReply(stdout, paths.length)); } catch (cause) { reject(cause); }
      });
      const stopAfterInputFailure = (cause: unknown) => {
        inputError ??= cause;
        // The execFile callback joins child exit and pipe closure. Even a
        // synchronous input failure must not leave an unowned helper running.
        try { child.kill("SIGKILL"); } catch { /* Preserve the input failure and join the callback. */ }
      };
      if (!child.stdin) {
        stopAfterInputFailure(new Error("metadata command input is unavailable"));
        return;
      }
      try {
        child.stdin.on("error", stopAfterInputFailure);
        child.stdin.end(JSON.stringify(paths));
      } catch (cause) { stopAfterInputFailure(cause); }
    } catch (cause) { reject(commandFailure(cause)); }
  });
}

/** Input spelling has already been admitted by the public API; do not resolve it again. */
export async function readDarwinCloneFileMetadata(paths: readonly string[]): Promise<(Buffer | null)[]> {
  const results: (Buffer | null)[] = Array(paths.length).fill(null);
  let batch: string[] = [];
  let indices: number[] = [];
  let bytes = 2;
  const flush = async () => {
    if (!batch.length) return;
    const observed = await inspectBatch(batch);
    for (let i = 0; i < observed.length; i++) results[indices[i]!] = observed[i]!;
    batch = [];
    indices = [];
    bytes = 2;
  };
  for (let i = 0; i < paths.length; i++) {
    const spelling = paths[i]!;
    if (typeof spelling !== "string" || !spelling.startsWith("/") || spelling.includes("\0")) {
      throw new FsSafeError("invalid-path", "clone metadata requires absolute paths without NUL bytes");
    }
    // Darwin pathname syscalls return ENAMETOOLONG at this byte boundary;
    // the native reader reports that per-entry failure as absent metadata.
    if (Buffer.byteLength(spelling) >= DARWIN_PATH_MAX) continue;
    // Match Node/N-API UTF-8 conversion. JXA's C-string bridge otherwise
    // rejects lone UTF-16 surrogates instead of observing the U+FFFD spelling.
    const pathname = Buffer.from(spelling, "utf8").toString("utf8");
    const size = Buffer.byteLength(JSON.stringify(pathname)) + 1;
    if (batch.length === MAX_BATCH_PATHS || bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push(pathname);
    indices.push(i);
    bytes += size;
  }
  await flush();
  return results;
}
