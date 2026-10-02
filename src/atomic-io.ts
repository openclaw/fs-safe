import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { readBoundedSync } from "./bounded-read.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { sleep, sleepSync } from "./timing.js";
import { assertExclusiveCreateStat } from "./exclusive-create.js";
import { hasNodeErrorCode } from "./path.js";

export type Procedure<T> = Generator<unknown, T, unknown>;
type SyncFchmod = (fd: number, mode: number) => void;

type AsyncAtomicFileSystem = Partial<Pick<
  typeof fs,
  "open" | "lstat" | "mkdir" | "rename" | "rm" | "unlink" | "writeFile"
>>;
type SyncAtomicFileSystem = Partial<Pick<
  typeof syncFs,
  | "openSync" | "lstatSync" | "mkdirSync" | "renameSync" | "rmSync" | "unlinkSync"
  | "fstatSync" | "closeSync" | "fsyncSync" | "writeFileSync" | "readFileSync"
  | "readSync" | "writeSync" | "ftruncateSync"
>>;

export function* wait<T>(value: T | PromiseLike<T>): Procedure<T> {
  return (yield value) as T;
}

export async function runAsync<T>(procedure: Procedure<T>): Promise<T> {
  let step = procedure.next();
  while (!step.done) {
    let value: unknown;
    try {
      value = await step.value;
    } catch (error) {
      step = procedure.throw(error);
      continue;
    }
    step = procedure.next(value);
  }
  return step.value;
}

export function runSync<T>(procedure: Procedure<T>): T {
  let step = procedure.next();
  // Sync adapters retain their ordinary return values; this driver never reads then.
  while (!step.done) step = procedure.next(step.value);
  return step.value;
}

export function inspectAtomicIdentity<T extends Pick<BigIntStats, "dev" | "ino">>(
  io: AtomicIo,
  read: () => T | Promise<T>,
  expected?: Pick<BigIntStats, "dev" | "ino">,
  synchronous = false,
  admit?: (stat: T) => void,
): T | Promise<T> {
  if (io.asynchronous && !synchronous) {
    const inspect = admit ? async () => {
      const stat = await read();
      admit(stat);
      return stat;
    } : read;
    return inspectFileIdentity(inspect, expected);
  }
  // Sync metadata is an ordinary value, including objects with a then getter.
  const inspect = admit ? () => {
    const stat = read() as T;
    admit(stat);
    return stat;
  } : read as () => T;
  return inspectFileIdentitySync(inspect, expected);
}

/** One adapter per operation; each admitted descriptor receives one AtomicFile. */
export class AtomicIo {
  readonly asynchronous: boolean;

  private constructor(
    readonly asyncFs: AsyncAtomicFileSystem | undefined,
    readonly syncFs: SyncAtomicFileSystem | undefined,
    public fchmodSync?: SyncFchmod,
  ) {
    this.asynchronous = asyncFs !== undefined;
  }

  static async(fsModule: AsyncAtomicFileSystem): AtomicIo {
    return new AtomicIo(fsModule, undefined);
  }

  static sync(fsModule: SyncAtomicFileSystem, fchmodSync?: SyncFchmod): AtomicIo {
    return new AtomicIo(undefined, fsModule, fchmodSync);
  }

  wrap(resource: FileHandle | number): AtomicFile {
    return new AtomicFile(this, resource);
  }

  *open(pathname: string, flags: string | number, mode?: number): Procedure<AtomicFile> {
    const withMode = arguments.length > 2;
    const exclusive = syncFs.constants.O_CREAT | syncFs.constants.O_EXCL;
    if (process.platform === "win32" && (typeof flags === "string"
      ? flags.includes("x") : (flags & exclusive) === exclusive)) {
      try { assertExclusiveCreateStat(pathname, yield* this.lstat(pathname)); }
      catch (error) { if (!hasNodeErrorCode(error, "ENOENT")) throw error; }
    }
    const resource = this.asyncFs
      ? yield* wait(withMode
        ? this.asyncFs.open!(pathname, flags, mode)
        : this.asyncFs.open!(pathname, flags))
      : withMode
        ? this.syncFs!.openSync!(pathname, flags, mode)
        : this.syncFs!.openSync!(pathname, flags);
    return this.wrap(resource);
  }

  *lstat(pathname: string): Procedure<Stats> {
    if (!this.asyncFs) return this.syncFs!.lstatSync!(pathname);
    if (this.asyncFs === fs) return syncFs.lstatSync(pathname);
    return yield* wait(this.asyncFs.lstat!(pathname));
  }

  lstatExact(pathname: string, synchronousBuiltin = true): BigIntStats | Promise<BigIntStats> {
    if (!this.asyncFs) return this.syncFs!.lstatSync!(pathname, { bigint: true });
    if (synchronousBuiltin && this.asyncFs === fs) return syncFs.lstatSync(pathname, { bigint: true });
    return this.asyncFs.lstat!(pathname, { bigint: true });
  }

  *mkdir(directory: string, mode: number): Procedure<void> {
    if (this.asyncFs) {
      const pathname = this.asyncFs === fs ? recursiveMkdirPath(directory) : directory;
      yield* wait(this.asyncFs.mkdir!(pathname, { recursive: true, mode }));
    } else {
      const pathname = this.syncFs === syncFs ? recursiveMkdirPath(directory) : directory;
      this.syncFs!.mkdirSync!(pathname, { recursive: true, mode });
    }
  }

  *rename(source: string, destination: string): Procedure<void> {
    if (this.asyncFs) yield* wait(this.asyncFs.rename!(source, destination));
    else this.syncFs!.renameSync!(source, destination);
  }

  *remove(pathname: string): Procedure<void> {
    if (this.asyncFs) yield* wait(this.asyncFs.rm!(pathname, { force: true }));
    else this.syncFs!.rmSync!(pathname, { force: true });
  }

  *unlink(pathname: string): Procedure<void> {
    if (this.asyncFs) yield* wait(this.asyncFs.unlink!(pathname));
    else this.syncFs!.unlinkSync!(pathname);
  }

  *delay(milliseconds: number): Procedure<void> {
    if (this.asynchronous) yield* wait(sleep(milliseconds));
    else sleepSync(milliseconds);
  }
}

export class AtomicFile {
  constructor(readonly io: AtomicIo, readonly resource: FileHandle | number) {}

  get fd(): number {
    return typeof this.resource === "number" ? this.resource : this.resource.fd;
  }

  *stat(): Procedure<Stats> {
    if (typeof this.resource === "number") return this.io.syncFs!.fstatSync!(this.resource);
    if (this.io.asyncFs === fs) return syncFs.fstatSync(this.resource.fd);
    return yield* wait(this.resource.stat());
  }

  statExact(): BigIntStats | Promise<BigIntStats> {
    if (typeof this.resource === "number") return this.io.syncFs!.fstatSync!(this.resource, { bigint: true });
    if (this.io.asyncFs === fs) return syncFs.fstatSync(this.resource.fd, { bigint: true });
    return this.resource.stat({ bigint: true });
  }

  close(): void | Promise<void> {
    if (typeof this.resource === "number") this.io.syncFs!.closeSync!(this.resource);
    else return this.resource.close();
  }

  *sync(): Procedure<void> {
    if (typeof this.resource === "number") this.io.syncFs!.fsyncSync!(this.resource);
    else yield* wait(this.resource.sync());
  }

  *syncBestEffort(): Procedure<void> {
    try {
      yield* this.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM") throw error;
    }
  }

  chmod(mode: number): void | Promise<void> {
    if (typeof this.resource === "number") {
      const chmod = this.io.fchmodSync;
      chmod?.(this.resource, mode);
    } else {
      return this.resource.chmod(mode);
    }
  }

  writeFile(data: string | Uint8Array, throughModule = false): void | Promise<void> {
    if (typeof this.resource === "number") {
      this.io.syncFs!.writeFileSync!(this.resource, data);
    } else if (throughModule) {
      return this.io.asyncFs!.writeFile!(this.resource, data);
    } else {
      return this.resource.writeFile(data);
    }
  }

  *readFile(sizeHint?: number): Procedure<Buffer> {
    if (typeof this.resource !== "number") return yield* wait(this.resource.readFile());
    if (sizeHint === undefined) return this.io.syncFs!.readFileSync!(this.resource);
    const fd = this.resource;
    let position = 0;
    return readBoundedSync(Infinity, (buffer, length) => {
      const bytesRead = this.io.syncFs!.readSync!(fd, buffer, 0, length, position);
      position += bytesRead;
      return bytesRead;
    }, { initialSize: Number.isSafeInteger(sizeHint) && sizeHint >= 0 ? sizeHint : undefined });
  }

  read(buffer: Buffer, offset: number, length: number, position: number | null): number | Promise<{ bytesRead: number }> {
    if (typeof this.resource === "number") {
      return this.io.syncFs!.readSync!(this.resource, buffer, offset, length, position);
    }
    return this.resource.read(buffer, offset, length, position);
  }

  write(buffer: Buffer, offset: number, length: number, position: number | null): number | Promise<{ bytesWritten: number }> {
    if (typeof this.resource === "number") {
      const written = this.io.syncFs!.writeSync!(this.resource, buffer, offset, length, position);
      if (written === 0) throw new Error("Copy fallback write made no progress");
      return written;
    }
    return this.resource.write(buffer, offset, length, position);
  }

  *truncate(length: number): Procedure<void> {
    if (typeof this.resource === "number") this.io.syncFs!.ftruncateSync!(this.resource, length);
    else yield* wait(this.resource.truncate(length));
  }
}
