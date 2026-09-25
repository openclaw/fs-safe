import { Worker } from "node:worker_threads";
import { FsSafeError } from "./errors.js";
import { createSuppressedError } from "./suppressed-error.js";

export type NodeWatchHint = { directory: string; name: string | null; event: string };
export type NodeWatchBatch = { hints: NodeWatchHint[]; overflow: boolean };

// Fixed program, no interpolated paths/code. It only registers advisory directory
// hints; all path admission and authoritative observation stay in guarded scans.
const program = String.raw`
(async () => {
// Dynamic imports work with both CommonJS and inherited --input-type=module.
// Keep inherited runtime/security flags intact rather than clearing execArgv.
const { parentPort, workerData } = await import('node:worker_threads');
const { watch } = await import('node:fs');
const watches = new Map();
let outstanding = false;
let hints = new Map();
let overflow = false;
let failed = false;
let closing = false;
const closeErrors = [];
function send() {
  if (closing || failed || outstanding || (!overflow && hints.size === 0)) return;
  outstanding = true;
  parentPort.postMessage({ type: 'dirty', hints: [...hints.values()], overflow });
  hints.clear();
  overflow = false;
}
function dirty(directory, event, name) {
  if (closing || failed) return;
  if (workerData.recursiveRoot && typeof name === 'string') {
    const parts = name.replaceAll(String.fromCharCode(92), '/').split('/');
    if (name.includes(String.fromCharCode(0)) || parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
      directory = ''; name = null;
    } else {
      name = parts.pop(); directory = parts.join(String.fromCharCode(92));
    }
  }
  if (!overflow) {
    if (hints.size >= workerData.maxPendingPaths) { hints.clear(); overflow = true; }
    else {
      const key = JSON.stringify([directory, name]);
      const prior = hints.get(key);
      hints.set(key, { directory, event: prior?.event === "rename" ? "rename" : event, name });
    }
  }
  send();
}
function failure(error) {
  if (closing) { closeErrors.push({ message: error.message, code: error.code }); return; }
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'error', message: error.message, code: error.code });
}
parentPort.on('message', command => {
  if (command.type === 'close') {
    if (closing) return;
    closing = true;
    // Bun's watch manager is process-global. Detach our registrations explicitly;
    // a joined JS worker does not own the runtime's shared driver descriptor.
    for (const handle of watches.values()) {
      try { handle.close(); }
      catch (error) { closeErrors.push({ message: error.message, code: error.code }); }
    }
    watches.clear(); hints.clear();
    parentPort.postMessage({ type: 'closed', errors: closeErrors });
    parentPort.close();
    return;
  }
  if (closing) return;
  if (command.type === 'ack') {
    outstanding = false;
    send();
    return;
  }
  if (failed) return;
  try {
    if (command.type === 'add') {
      const handle = watch(command.path, { recursive: workerData.recursiveRoot }, (event, name) => dirty(command.relative, event, name));
      watches.set(command.path, handle);
      handle.on('error', failure);
    }
    parentPort.postMessage({ type: 'reply', id: command.id });
  } catch (error) { failure(error); }
});
})();
`;

export class NodeWatchBackend {
  private readonly worker: Worker;
  private readonly recursiveRoot = process.platform === "win32";
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
    try {
      this.worker = new Worker(program, { eval: true, name: "fs-safe-watch", workerData: { maxPendingPaths, recursiveRoot: this.recursiveRoot } });
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
    // ReadDirectoryChangesW already covers the admitted subtree. Holding child
    // directory watches prevents ancestor moves on Windows; never use Node’s
    // recursive Linux implementation (which creates per-file registrations).
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
