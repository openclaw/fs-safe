import { Worker } from "node:worker_threads";
import { FsSafeError } from "./errors.js";

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
function send() {
  if (failed || outstanding || (!overflow && hints.size === 0)) return;
  outstanding = true;
  parentPort.postMessage({ type: 'dirty', hints: [...hints.values()], overflow });
  hints.clear();
  overflow = false;
}
function dirty(directory, event, name) {
  if (failed) return;
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
  if (failed) return;
  failed = true;
  parentPort.postMessage({ type: 'error', message: error.message, code: error.code });
}
parentPort.on('message', command => {
  if (command.type === 'ack') {
    outstanding = false;
    send();
    return;
  }
  if (failed) return;
  try {
    if (command.type === 'add') {
      const handle = watch(command.path, { recursive: false }, (event, name) => dirty(command.relative, event, name));
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
  private nextId = 0;
  private pending = new Map<number, { resolve(): void; reject(error: unknown): void }>();
  private closing?: Promise<void>;
  private stopped = false;
  private failure?: unknown;
  private readonly exited: Promise<void>;

  constructor(onDirty: (batch: NodeWatchBatch) => void, onError: (error: unknown) => void, persistent: boolean, maxPendingPaths: number) {
    try {
      this.worker = new Worker(program, { eval: true, name: "fs-safe-watch", workerData: { maxPendingPaths } });
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
    this.worker.on("error", error => this.fail(error, onError));
    this.worker.on("message", message => {
      if (this.stopped) return;
      if (message.type === "error") {
        this.fail(new FsSafeError("helper-failed", "directory watch failed", {
          details: { code: message.code, operation: "watch" },
          cause: new Error(message.message),
        }), onError);
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
  add(path: string, relative: string): Promise<void> { return this.command("add", path, relative); }
  drainCommands(): Promise<void> { return this.command("barrier"); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const waiter of this.pending.values()) waiter.reject(new DOMException("Watch closed", "AbortError"));
    this.pending.clear();
    // FSWatcher 'close' is only nextTick in Node. Terminating and joining the
    // owning worker also drains its native event loop, not just JS callbacks.
    this.closing = (async () => {
      await this.worker.terminate();
      await this.exited;
      if (this.failure !== undefined) throw this.failure;
    })();
    return this.closing;
  }
}
