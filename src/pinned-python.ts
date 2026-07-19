import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsSync from "node:fs";
import { FsSafeError } from "./errors.js";
import { getFsSafePythonConfig } from "./pinned-python-config.js";

const PINNED_PYTHON_WORKER_SOURCE = String.raw`
import base64, errno, json, os, secrets, stat, sys
DIR_FLAGS = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"): DIR_FLAGS |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"): DIR_FLAGS |= os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY
if hasattr(os, "O_NONBLOCK"): READ_FLAGS |= os.O_NONBLOCK
if hasattr(os, "O_NOFOLLOW"): READ_FLAGS |= os.O_NOFOLLOW
WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    WRITE_FLAGS |= os.O_NOFOLLOW
def split_relative(value):
    if value in ("", "."):
        return []
    if "\x00" in value or value.startswith("/") or value.startswith("//"):
        raise OSError(errno.EPERM, "invalid relative path")
    if value.startswith("..\\"):
        raise OSError(errno.EPERM, "path traversal is not allowed")
    parts = [part for part in value.split("/") if part and part != "."]
    for part in parts:
        if part == "..":
            raise OSError(errno.EPERM, "path traversal is not allowed")
    return parts
def open_dir(path_value, dir_fd=None):
    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)
def walk_dir(root_fd, segments, mkdir_enabled=False):
    current_fd = os.dup(root_fd)
    try:
        for segment in segments:
            try:
                next_fd = open_dir(segment, dir_fd=current_fd)
            except FileNotFoundError:
                if not mkdir_enabled:
                    raise
                os.mkdir(segment, 0o777, dir_fd=current_fd)
                next_fd = open_dir(segment, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise
def parent_and_basename(root_fd, relative):
    segments = split_relative(relative)
    if not segments:
        raise OSError(errno.EPERM, "operation requires a non-root path")
    parent_fd = walk_dir(root_fd, segments[:-1])
    return parent_fd, segments[-1]
def encode_stat(st):
    mode = st.st_mode
    return {
        "dev": st.st_dev,
        "gid": st.st_gid,
        "ino": st.st_ino,
        "isDirectory": stat.S_ISDIR(mode),
        "isFile": stat.S_ISREG(mode),
        "isSymbolicLink": stat.S_ISLNK(mode),
        "mode": mode,
        "mtimeMs": st.st_mtime * 1000,
        "nlink": st.st_nlink,
        "size": st.st_size,
        "uid": st.st_uid,
    }
def reject_unsafe_endpoint(st):
    mode = st.st_mode
    if stat.S_ISLNK(mode):
        raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
    if stat.S_ISREG(mode) and st.st_nlink > 1:
        raise OSError(errno.EPERM, "hardlinked file endpoint is not allowed")
def copy_bytes(source_fd, dest_fd):
    while True:
        chunk = os.read(source_fd, 65536)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(dest_fd, view)
            if written <= 0:
                raise OSError(errno.EIO, "short write")
            view = view[written:]
def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        view = view[written:]
def fsync_best_effort(fd):
    try: os.fsync(fd)
    except OSError as error:
        if error.errno != errno.EPERM: raise
def link_unsupported(exc):
    unsupported = (errno.EPERM, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP))
    return getattr(exc, "errno", None) in unsupported
def link_no_replace(name, new_name, source_fd, target_fd):
    linked = False
    try:
        os.link(name, new_name, src_dir_fd=source_fd, dst_dir_fd=target_fd, follow_symlinks=False)
        linked = True
        os.unlink(name, dir_fd=source_fd)
    except Exception:
        if linked:
            try: os.unlink(new_name, dir_fd=target_fd)
            except FileNotFoundError: pass
        raise
    os.fsync(source_fd)
    if source_fd != target_fd:
        os.fsync(target_fd)
def copy_file_no_replace(source_parent_fd, source_name, target_parent_fd, basename, mode, expected=None, unlink_source=False):
    source_fd = os.open(source_name, READ_FLAGS, dir_fd=source_parent_fd)
    dest_fd = None; success = False; dest_stat = None
    try:
        if expected is not None:
            source_stat = os.fstat(source_fd)
            if source_stat.st_dev != expected.st_dev or source_stat.st_ino != expected.st_ino:
                raise RuntimeError("fs-safe-source-mismatch")
        dest_fd = os.open(basename, WRITE_FLAGS, mode, dir_fd=target_parent_fd)
        copy_bytes(source_fd, dest_fd)
        os.fsync(dest_fd)
        dest_stat = os.fstat(dest_fd)
        success = True
    finally:
        os.close(source_fd)
        if dest_fd is not None:
            os.close(dest_fd)
        if dest_fd is not None and not success:
            try: os.unlink(basename, dir_fd=target_parent_fd)
            except FileNotFoundError: pass
    if unlink_source:
        try:
            os.unlink(source_name, dir_fd=source_parent_fd)
        except Exception:
            try: os.unlink(basename, dir_fd=target_parent_fd)
            except FileNotFoundError: pass
            raise
    return dest_stat
def same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino
def verify_temp_name(parent_fd, temp_name, expected_stat):
    current_stat = os.lstat(temp_name, dir_fd=parent_fd)
    if stat.S_ISLNK(current_stat.st_mode) or not same_identity(current_stat, expected_stat):
        raise RuntimeError("fs-safe-temp-mismatch")
def verify_committed_temp(parent_fd, basename, expected_stat):
    final_stat = os.lstat(basename, dir_fd=parent_fd)
    if not stat.S_ISLNK(final_stat.st_mode) and same_identity(final_stat, expected_stat):
        return final_stat
    try: os.unlink(basename, dir_fd=parent_fd)
    except FileNotFoundError: pass
    raise RuntimeError("fs-safe-temp-mismatch")
def commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, expected_stat):
    verify_temp_name(parent_fd, temp_name, expected_stat)
    if overwrite:
        os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        return verify_committed_temp(parent_fd, basename, expected_stat)
    else:
        try:
            os.link(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
            final_stat = verify_committed_temp(parent_fd, basename, expected_stat)
            os.unlink(temp_name, dir_fd=parent_fd)
            return final_stat
        except OSError as exc:
            if not link_unsupported(exc):
                raise
            return copy_file_no_replace(parent_fd, temp_name, parent_fd, basename, mode, expected_stat, True)
def assert_expected_root(root_fd, payload):
    if "rootDev" in payload or "rootIno" in payload:
        root_stat = os.fstat(root_fd)
        if root_stat.st_dev != int(payload["rootDev"]) or root_stat.st_ino != int(payload["rootIno"]):
            raise RuntimeError("fs-safe-root-mismatch")
def stat_path(root_fd, payload):
    relative = payload.get("relativePath", "")
    segments = split_relative(relative)
    if not segments:
        return encode_stat(os.fstat(root_fd))
    parent_fd, basename = parent_and_basename(root_fd, relative)
    try:
        st = os.lstat(basename, dir_fd=parent_fd)
        if payload.get("rejectSymlink", True) and stat.S_ISLNK(st.st_mode):
            raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
        return encode_stat(st)
    finally:
        os.close(parent_fd)
def readdir_path(root_fd, payload):
    dir_fd = walk_dir(root_fd, split_relative(payload.get("relativePath", "")))
    try:
        names = sorted(os.listdir(dir_fd))
        if not payload.get("withFileTypes", False):
            return names
        entries = []
        for name in names:
            st = os.lstat(name, dir_fd=dir_fd)
            entry = encode_stat(st)
            entry["name"] = name
            entries.append(entry)
        return entries
    finally:
        os.close(dir_fd)
def mkdirp_path(root_fd, payload):
    dir_fd = walk_dir(root_fd, split_relative(payload.get("relativePath", "")), mkdir_enabled=True)
    os.close(dir_fd); return None
def remove_tree(parent_fd, basename):
    st = os.lstat(basename, dir_fd=parent_fd)
    if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
        dir_fd = open_dir(basename, dir_fd=parent_fd)
        try:
            for child in os.listdir(dir_fd):
                remove_tree(dir_fd, child)
        finally:
            os.close(dir_fd)
        os.rmdir(basename, dir_fd=parent_fd)
    else:
        os.unlink(basename, dir_fd=parent_fd)
def remove_path(root_fd, payload):
    parent_fd, basename = parent_and_basename(root_fd, payload.get("relativePath", ""))
    try:
        try:
            st = os.lstat(basename, dir_fd=parent_fd)
        except FileNotFoundError:
            if payload.get("force", True):
                return None
            raise
        if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
            if payload.get("recursive", False):
                remove_tree(parent_fd, basename)
            else:
                os.rmdir(basename, dir_fd=parent_fd)
        else:
            os.unlink(basename, dir_fd=parent_fd)
        return None
    finally:
        os.close(parent_fd)

def rename_path(root_fd, payload):
    from_parent_fd, from_base = parent_and_basename(root_fd, payload["from"])
    to_parent_fd, to_base = parent_and_basename(root_fd, payload["to"])
    try:
        from_stat = os.lstat(from_base, dir_fd=from_parent_fd)
        reject_unsafe_endpoint(from_stat)
        overwrite = payload.get("overwrite", True)
        if not overwrite and stat.S_ISREG(from_stat.st_mode):
            try:
                link_no_replace(from_base, to_base, from_parent_fd, to_parent_fd)
            except OSError as exc:
                if not link_unsupported(exc):
                    raise
                copy_file_no_replace(from_parent_fd, from_base, to_parent_fd, to_base, stat.S_IMODE(from_stat.st_mode), from_stat, True)
            return None
        if not overwrite and stat.S_ISDIR(from_stat.st_mode):
            raise RuntimeError("fs-safe-directory-noreplace-unsupported")
        if not overwrite:
            try:
                os.lstat(to_base, dir_fd=to_parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", to_base)
            except FileNotFoundError:
                pass
        os.rename(from_base, to_base, src_dir_fd=from_parent_fd, dst_dir_fd=to_parent_fd)
        os.fsync(from_parent_fd)
        if from_parent_fd != to_parent_fd:
            os.fsync(to_parent_fd)
        return None
    finally:
        os.close(from_parent_fd)
        os.close(to_parent_fd)

def create_temp_file(parent_fd, basename, mode):
    prefix = "." + basename + "."
    for _ in range(128):
        candidate = prefix + secrets.token_hex(6) + ".tmp"
        try:
            fd = os.open(candidate, WRITE_FLAGS, mode, dir_fd=parent_fd)
            return candidate, fd
        except FileExistsError:
            continue
    raise RuntimeError("failed to allocate pinned temp file")

def write_path(root_fd, payload):
    parent_fd = walk_dir(root_fd, split_relative(payload.get("relativeParentPath", "")), bool(payload.get("mkdir", True)))
    temp_fd = None
    temp_name = None
    basename = payload["basename"]
    mode = int(payload.get("mode", 0o600))
    overwrite = bool(payload.get("overwrite", True))
    max_bytes = int(payload.get("maxBytes", -1))
    data = base64.b64decode(payload.get("base64", ""))
    try:
        if max_bytes >= 0 and len(data) > max_bytes:
            raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, len(data)))
        if not overwrite:
            try:
                os.lstat(basename, dir_fd=parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", basename)
            except FileNotFoundError:
                pass
        temp_name, temp_fd = create_temp_file(parent_fd, basename, mode)
        os.fchmod(temp_fd, mode)
        write_all(temp_fd, data)
        fsync_best_effort(temp_fd)
        temp_stat = os.fstat(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        result_stat = commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, temp_stat)
        temp_name = None
        fsync_best_effort(parent_fd)
        return {"dev": result_stat.st_dev, "ino": result_stat.st_ino}
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)

def copy_path(root_fd, payload):
    source_fd = os.open(payload["sourcePath"], READ_FLAGS)
    parent_fd = None
    temp_fd = None
    temp_name = None
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeError("fs-safe-not-file")
        if source_stat.st_dev != int(payload["sourceDev"]) or source_stat.st_ino != int(payload["sourceIno"]):
            raise RuntimeError("fs-safe-source-mismatch")
        basename = payload["basename"]
        mode = int(payload.get("mode", 0o600))
        overwrite = bool(payload.get("overwrite", True))
        max_bytes = int(payload.get("maxBytes", -1))
        if max_bytes >= 0 and source_stat.st_size > max_bytes:
            raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, source_stat.st_size))
        parent_fd = walk_dir(root_fd, split_relative(payload.get("relativeParentPath", "")), bool(payload.get("mkdir", True)))
        temp_name, temp_fd = create_temp_file(parent_fd, basename, mode)
        os.fchmod(temp_fd, mode)
        written_bytes = 0
        while True:
            chunk = os.read(source_fd, 65536)
            if not chunk:
                break
            written_bytes += len(chunk)
            if max_bytes >= 0 and written_bytes > max_bytes:
                raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, written_bytes))
            view = memoryview(chunk)
            while view:
                written = os.write(temp_fd, view)
                if written <= 0:
                    raise OSError(errno.EIO, "short write")
                view = view[written:]
        os.fsync(temp_fd)
        temp_stat = os.fstat(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        result_stat = commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, temp_stat)
        temp_name = None
        os.fsync(parent_fd)
        return {"dev": result_stat.st_dev, "ino": result_stat.st_ino}
    finally:
        os.close(source_fd)
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None and parent_fd is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd is not None:
            os.close(parent_fd)

def run_operation(operation, root_path, payload):
    root_fd = open_dir(root_path)
    try:
        assert_expected_root(root_fd, payload)
        if operation == "stat":
            return stat_path(root_fd, payload)
        if operation == "readdir":
            return readdir_path(root_fd, payload)
        if operation == "mkdirp":
            return mkdirp_path(root_fd, payload)
        if operation == "remove":
            return remove_path(root_fd, payload)
        if operation == "rename":
            return rename_path(root_fd, payload)
        if operation == "write":
            return write_path(root_fd, payload)
        if operation == "copy":
            return copy_path(root_fd, payload)
        raise RuntimeError("unknown operation: " + operation)
    finally:
        os.close(root_fd)

for line in sys.stdin:
    try:
        request = json.loads(line)
        result = run_operation(request["operation"], request["rootPath"], request.get("payload") or {})
        response = {"id": request["id"], "ok": True, "result": result}
    except Exception as exc:
        response = {
            "id": request.get("id") if isinstance(locals().get("request"), dict) else None,
            "ok": False,
            "code": exc.__class__.__name__,
            "errno": getattr(exc, "errno", None),
            "message": str(exc),
        }
    print(json.dumps(response, separators=(",", ":")), flush=True)
`;

type PinnedPythonOperation =
  | "copy"
  | "stat"
  | "readdir"
  | "mkdirp"
  | "remove"
  | "rename"
  | "write";

type PendingRequest = {
  reject(error: unknown): void;
  resolve(value: unknown): void;
};

type PinnedPythonWorker = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingRequest>;
  stderr: string;
  stdoutBuffer: string;
};

let nextRequestId = 1;
let worker: PinnedPythonWorker | null = null;

export function __resetPinnedPythonWorkerForTest(): void {
  const currentWorker = worker;
  worker = null;
  if (!currentWorker) {
    return;
  }
  currentWorker.pending.clear();
  currentWorker.child.kill("SIGTERM");
}

const PYTHON_CANDIDATE_DEFAULTS = [
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
];

function canExecute(binPath: string): boolean {
  try {
    fsSync.accessSync(binPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePython(): string {
  const configured = getFsSafePythonConfig().pythonPath;
  if (configured) {
    return configured;
  }
  for (const candidate of PYTHON_CANDIDATE_DEFAULTS) {
    if (canExecute(candidate)) {
      return candidate;
    }
  }
  return "python3";
}

function assertPinnedHelperSupported(): void {
  if (process.platform === "win32") {
    throw new FsSafeError(
      "unsupported-platform",
      "fd-relative pinned filesystem operations are not available on Windows",
    );
  }
  if (getFsSafePythonConfig().mode === "off") {
    throw new FsSafeError("helper-unavailable", "Python helper is disabled");
  }
}

function isSpawnUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const maybeErrno = error as NodeJS.ErrnoException;
  return (
    typeof maybeErrno.syscall === "string" &&
    maybeErrno.syscall.startsWith("spawn") &&
    ["EACCES", "ENOENT", "ENOEXEC"].includes(maybeErrno.code ?? "")
  );
}

function mapWorkerError(response: Record<string, unknown>): Error {
  const code = typeof response.code === "string" ? response.code : "";
  const errno = typeof response.errno === "number" ? response.errno : undefined;
  const message =
    typeof response.message === "string" && response.message
      ? response.message
      : "pinned helper failed";
  const tooLarge = message.match(/fs-safe-too-large:(\d+):(\d+)/);
  if (tooLarge) {
    const [, limit, got] = tooLarge;
    return new FsSafeError("too-large", `file exceeds limit of ${limit} bytes (got at least ${got})`);
  }
  if (message.includes("fs-safe-not-file")) {
    return new FsSafeError("not-file", "not a file");
  }
  if (message.includes("fs-safe-source-mismatch")) {
    return new FsSafeError("path-mismatch", "source path changed during copy");
  }
  if (message.includes("fs-safe-temp-mismatch")) {
    return new FsSafeError("path-mismatch", "temp path changed during write");
  }
  if (message.includes("fs-safe-root-mismatch")) {
    return new FsSafeError("path-mismatch", "root path changed during operation");
  }
  if (message.includes("fs-safe-directory-noreplace-unsupported")) {
    return new FsSafeError("invalid-path", "directory moves require overwrite: true");
  }
  if (code === "FileNotFoundError" || errno === 2) {
    return new FsSafeError("not-found", "file not found");
  }
  if (code === "FileExistsError" || errno === 17) {
    return new FsSafeError("already-exists", message);
  }
  if (errno === 39) {
    return new FsSafeError("not-empty", "directory is not empty");
  }
  if (errno === 1 || errno === 13 || errno === 21) {
    return new FsSafeError("not-removable", "path is not removable under root");
  }
  if (code === "NotADirectoryError" || code === "OSError" || errno === 20 || errno === 40) {
    return new FsSafeError("path-alias", message);
  }
  return new FsSafeError("helper-failed", message);
}

function rejectPending(error: Error, targetWorker = worker): void {
  if (!targetWorker || worker !== targetWorker) {
    return;
  }
  setWorkerRef(targetWorker, false);
  for (const pending of targetWorker.pending.values()) {
    pending.reject(error);
  }
  targetWorker.pending.clear();
  worker = null;
}

function handleWorkerLine(currentWorker: PinnedPythonWorker, line: string): void {
  if (worker !== currentWorker || !line.trim()) {
    return;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line) as unknown;
  } catch {
    rejectPending(
      new FsSafeError("helper-failed", `pinned helper returned invalid JSON: ${line}`),
      currentWorker,
    );
    return;
  }
  if (typeof decoded !== "object" || decoded === null || !("id" in decoded)) {
    rejectPending(
      new FsSafeError("helper-failed", "pinned helper returned invalid response"),
      currentWorker,
    );
    return;
  }
  const response = decoded as { id?: unknown; ok?: unknown; result?: unknown };
  const id = typeof response.id === "number" ? response.id : undefined;
  if (id === undefined) {
    return;
  }
  const pending = currentWorker.pending.get(id);
  if (!pending) {
    return;
  }
  currentWorker.pending.delete(id);
  if (currentWorker.pending.size === 0) {
    setWorkerRef(currentWorker, false);
  }
  if (response.ok === true) {
    pending.resolve(response.result);
    return;
  }
  pending.reject(mapWorkerError(decoded as Record<string, unknown>));
}

function getWorker() {
  assertPinnedHelperSupported();
  if (worker) {
    return worker;
  }
  const child = spawn(resolvePython(), ["-u", "-c", PINNED_PYTHON_WORKER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const currentWorker: PinnedPythonWorker = { child, pending: new Map(), stderr: "", stdoutBuffer: "" };
  worker = currentWorker;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (worker !== currentWorker) {
      return;
    }
    currentWorker.stdoutBuffer += chunk;
    for (;;) {
      const newline = currentWorker.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = currentWorker.stdoutBuffer.slice(0, newline);
      currentWorker.stdoutBuffer = currentWorker.stdoutBuffer.slice(newline + 1);
      handleWorkerLine(currentWorker, line);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (worker === currentWorker) {
      currentWorker.stderr = `${currentWorker.stderr}${chunk}`.slice(-4096);
    }
  });
  child.once("error", (error) => {
    const mapped = isSpawnUnavailable(error)
      ? new FsSafeError("helper-unavailable", "Python helper is unavailable", { cause: error })
      : error instanceof Error
        ? error
        : new Error(String(error));
    rejectPending(mapped, currentWorker);
  });
  child.once("close", (code, signal) => {
    const stderr = currentWorker.stderr.trim();
    rejectPending(
      new FsSafeError(
        "helper-failed",
        stderr || `pinned helper exited with code ${code ?? "null"} (${signal ?? "?"})`,
      ),
      currentWorker,
    );
  });
  process.once("exit", () => {
    child.kill("SIGTERM");
  });
  setWorkerRef(currentWorker, false);
  return currentWorker;
}

function setRefable(value: unknown, ref: boolean): void {
  if (!value) {
    return;
  }
  const method = ref ? "ref" : "unref";
  const refable = value as { ref?: () => void; unref?: () => void };
  refable[method]?.();
}

function setWorkerRef(currentWorker: PinnedPythonWorker, ref: boolean): void {
  setRefable(currentWorker.child, ref);
  setRefable(currentWorker.child.stdin, ref);
  setRefable(currentWorker.child.stdout, ref);
  setRefable(currentWorker.child.stderr, ref);
}

export async function runPinnedPythonOperation<T>(params: {
  operation: PinnedPythonOperation;
  rootPath: string;
  payload: Record<string, unknown>;
}): Promise<T> {
  const requestId = nextRequestId++;
  const currentWorker = getWorker();
  if (typeof currentWorker.child.stdin?.write !== "function") {
    throw new FsSafeError("helper-unavailable", "Python helper stdin is unavailable");
  }
  setWorkerRef(currentWorker, true);
  return await new Promise<T>((resolve, reject) => {
    currentWorker.pending.set(requestId, {
      reject,
      resolve: (value) => resolve(value as T),
    });
    const request = JSON.stringify({
      id: requestId,
      operation: params.operation,
      rootPath: params.rootPath,
      payload: params.payload,
    });
    currentWorker.child.stdin.write(`${request}\n`, (error) => {
      if (error) {
        currentWorker.pending.delete(requestId);
        if (currentWorker.pending.size === 0) {
          setWorkerRef(currentWorker, false);
        }
        reject(error);
      }
    });
  });
}

export function assertPinnedPythonOperationAvailable(): void {
  const currentWorker = getWorker();
  if (typeof currentWorker.child.stdin?.write !== "function") {
    throw new FsSafeError("helper-unavailable", "Python helper stdin is unavailable");
  }
}

export function validatePinnedOperationPayload(payload: Record<string, unknown>): void {
  if (typeof payload.relativePath === "string") {
    validatePinnedRelativePath(payload.relativePath);
  }
  if (typeof payload.relativeParentPath === "string") {
    validatePinnedRelativePath(payload.relativeParentPath);
  }
  if (typeof payload.from === "string") {
    validatePinnedRelativePath(payload.from);
  }
  if (typeof payload.to === "string") {
    validatePinnedRelativePath(payload.to);
  }
}

export function isPinnedHelperUnavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "helper-unavailable";
}
function validatePinnedRelativePath(relativePath: string): void {
  if (relativePath.length === 0 || relativePath === ".") {
    return;
  }
  if (relativePath.includes("\0")) {
    throw new FsSafeError("invalid-path", "relative path contains a NUL byte");
  }
  if (
    relativePath.startsWith("/") ||
    relativePath.startsWith("//") ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    throw new FsSafeError("invalid-path", "relative path must not escape root");
  }
  for (const segment of relativePath.split("/")) {
    if (segment === "..") {
      throw new FsSafeError("invalid-path", "relative path must not contain '..'");
    }
  }
}
