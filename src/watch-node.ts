import { Worker } from "node:worker_threads";
import { FsSafeError } from "./errors.js";
import { createSuppressedError } from "./suppressed-error.js";
import { nativeRecursiveWatchPlatform, nodeWatchProgram } from "./watch-worker.js";

// Other Node platforms reopen pathnames; Bun resolves proc-fd inputs back to
// names before registration. Neither route currently preserves a retained pin.
export const nativeWatchSupported = process.platform === "linux" && process.release.name === "node"
  && !process.versions.bun && !process.versions.deno;
export function assertNativeWatchSupported(): void {
  if (!nativeWatchSupported) throw new FsSafeError("helper-unavailable",
    "descriptor-bound native observation requires Node.js on Linux; select polling explicitly",
    { details: { operation: "watch", platform: process.platform, runtime: process.versions.bun ? "bun" : "node" } });
}

export type NodeWatchHint = { directory: string; name: string | null; event: string };
export type NodeWatchBatch = { hints: NodeWatchHint[]; overflow: boolean };

export class NodeWatchBackend {
  private readonly worker: Worker;
  readonly recursiveRoot = nativeRecursiveWatchPlatform(process.platform);
  private registrations = 0;
  private nextId = 0;
  private pending = new Map<number, { resolve(): void; reject(error: unknown): void }>();
  private closing?: Promise<void>;
  private stopped = false;
  private failure?: unknown;
  private readonly exited: Promise<void>;
  private closeReply?: (errors: Array<{ message: string; code?: string }>) => void;
  private closeReject?: (error: unknown) => void;

  constructor(onDirty: (batch: NodeWatchBatch) => void, onError: (error: unknown) => void, persistent: boolean, maxPendingPaths: number) {
    assertNativeWatchSupported();
    try {
      this.worker = new Worker(nodeWatchProgram, { eval: true, name: "fs-safe-watch", workerData: { maxPendingPaths, recursiveRoot: this.recursiveRoot, platform: process.platform } });
    } catch (cause) {
      throw new FsSafeError("helper-failed", "watch worker could not start", {
        cause, details: { operation: "watch", code: (cause as NodeJS.ErrnoException | null)?.code },
      });
    }
    this.exited = new Promise(resolve => this.worker.once("exit", code => {
      if (!this.stopped) this.fail(new FsSafeError("helper-failed", "watch worker exited", {
        details: { code, operation: "watch" },
      }), onError);
      resolve();
    }));
    this.worker.on("error", error => {
      if (this.stopped) this.closeReject?.(error);
      else this.fail(error, onError);
    });
    this.worker.on("message", message => {
      if (message.type === "closed") { this.closeReply?.(message.errors); return; }
      if (message.type === "error") {
        this.fail(new FsSafeError("helper-failed", "directory watch failed", {
          details: { code: message.code, operation: "watch" },
          cause: new Error(message.message),
        }), onError);
      } else if (this.stopped) { return;
      } else if (message.type === "dirty") {
        onDirty(message);
        if (!this.stopped) this.worker.postMessage({ type: "ack" });
      } else if (message.type === "reply") {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        waiter?.resolve();
      }
    });
    if (!persistent) this.worker.unref();
  }

  private fail(error: unknown, onError: (error: unknown) => void): void {
    if (this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    if (!this.stopped) onError(error);
  }

  private command(type: "add" | "barrier", path?: string, relative?: string): Promise<void> {
    if (this.stopped || this.failure !== undefined) return Promise.reject(
      this.failure ?? new DOMException("Watch closed", "AbortError"),
    );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ type, path, relative, id }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async add(path: string, relative: string): Promise<void> {
    if (this.stopped || this.failure !== undefined) throw this.failure ?? new DOMException("Watch closed", "AbortError");
    // Native Windows/Darwin recursion already covers the admitted subtree. Child
    // registrations block Windows ancestor moves and asynchronously restart the
    // Darwin FSEvents stream. Linux recursion would create per-file watches.
    if (this.recursiveRoot && relative !== "") return;
    await this.command("add", path, relative);
    this.registrations++;
  }
  directoryCount(): number { return this.registrations; }
  drainCommands(): Promise<void> { return this.command("barrier"); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const waiter of this.pending.values()) waiter.reject(new DOMException("Watch closed", "AbortError"));
    this.pending.clear();
    let acknowledged = false;
    const closeErrors = new Set<unknown>();
    const detached = new Promise<void>((resolve, reject) => {
      this.closeReject = error => { closeErrors.add(error); reject(error); };
      this.closeReply = errors => {
        acknowledged = true;
        if (errors.length) reject(new FsSafeError("helper-failed", "watch detach failed", {
          details: { operation: "close" }, cause: new AggregateError(errors.map(error => Object.assign(new Error(error.message), { code: error.code }))),
        }));
        else resolve();
      };
    });
    this.worker.ref();
    // Enroll shutdown before posting to a possibly reentrant worker transport.
    this.closing = Promise.resolve().then(async () => {
      try {
        await Promise.race([detached, this.exited.then(() => {
          if (!acknowledged) throw new FsSafeError("helper-failed", "watch worker exited before detach acknowledgement");
        })]);
      } catch (error) { closeErrors.add(error); }
      try { await this.worker.terminate(); }
      catch (error) { closeErrors.add(error); }
      // Detach closes the port too, so even a failed termination request must
      // still join actual worker exit before relinquishing ownership.
      await this.exited;
      this.closeReply = undefined;
      this.closeReject = undefined;
      this.registrations = 0;
      // Observation loss does not turn successful physical retirement into a
      // cleanup failure. Keep it supplementary only when retirement also fails.
      if (closeErrors.size) {
        const errors = [...closeErrors];
        const closeError = errors.slice(1).reduce((prior, error) => createSuppressedError(error, prior, "watch detach and join failed"), errors[0]);
        if (this.failure !== undefined) throw createSuppressedError(closeError, this.failure, "watch observation and retirement failed");
        throw closeError;
      }
    });
    try { this.worker.postMessage({ type: "close" }); }
    catch (error) { this.closeReject?.(error); }
    return this.closing;
  }
}
