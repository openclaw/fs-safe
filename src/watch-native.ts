import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { RootContext } from "./root-context.js";
import type { DirectoryIdentity, WatchSnapshot } from "./watch-scan.js";
import { watchStreamPaths } from "./watch-stream.js";
import type { WatchScope } from "./watch-types.js";

export type NativeWatchHint = { directory: string; name: string; event: "rename" | "change" | "children" | "subtree" };
export type NativeWatchBatch = { hints: NativeWatchHint[]; overflow: boolean; error?: string };
export type NativeWatchWireBatch = { hints: { directory: string; name: string; structural: boolean; flags?: number; namelessChild?: boolean; subtree?: boolean }[]; overflow: boolean; error?: string };
export type NativeWatchEntry = { scope: string; directory: { root: string; relative: string; rootDev: bigint; rootIno: bigint; dev: bigint; ino: bigint }; name: string; target?: DirectoryIdentity & { kind: string } };
export function watchBinding(mode: "auto" | "events" | "poll"): NativeBinding | undefined {
  if (mode === "poll") return;
  const binding = getNativeBinding("watchRegister", "watchAdd", "watchUnregister",
    ...(process.platform === "darwin" ? ["watchConfigure", "watchEntries"] as const : []));
  // Bun TSFN teardown remains unqualified; guarded native scans remain usable.
  if (binding && !process.versions.bun && !process.versions.deno && ["linux", "darwin", "win32"].includes(process.platform)) return binding;
  if (mode === "events" || getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "native watch events are unavailable", { details: { operation: "watch" } });
  }
}
export class NativeWatchBackend {
  private id: number | undefined;
  private streamPaths: string | undefined;
  directories: number | undefined;
  constructor(private binding: NativeBinding, private root: RootContext, callback: (batch: NativeWatchBatch) => void, limit: number, persistent: boolean) {
    this.streamPaths = JSON.stringify({ anchors: [], exclusions: [] });
    try { this.id = binding.watchRegister!(root.rootReal, limit, batch => {
      if (this.id !== undefined) callback({ overflow: batch.overflow, error: batch.error, hints: batch.hints.map(hint => ({
        directory: hint.directory, name: hint.name, event: hint.subtree ? "subtree" : hint.namelessChild ? "children" : hint.structural ? "rename" : "change",
      })) });
    }, persistent); } catch (cause) { throw watchError(cause); }
  }
  add(name: string, identity: DirectoryIdentity): void {
    try {
      this.binding.watchAdd!(this.id!, { root: this.root.rootReal, relative: name,
        rootDev: BigInt(this.root.rootIdentity.dev), rootIno: BigInt(this.root.rootIdentity.ino), ...identity });
    } catch (cause) {
      throw watchError(cause);
    }
  }
  testEvent(path: string, flags: number): void { this.binding.watchTestEvent!(this.id!, path, flags); }
  entries(snapshot: WatchSnapshot): boolean {
    if (process.platform !== "darwin") return false;
    const entries: NativeWatchEntry[] = [...snapshot.entryAnchors ?? []].map(([scope, anchor]) => ({
      scope, name: anchor.name, target: anchor.target,
      directory: { root: this.root.rootReal, relative: anchor.directory,
        rootDev: BigInt(this.root.rootIdentity.dev), rootIno: BigInt(this.root.rootIdentity.ino), ...snapshot.directories.get(anchor.directory)! },
    }));
    try {
      const result = this.binding.watchEntries!(this.id!, entries);
      this.directories = result.directories;
      return result.changed;
    } catch (cause) { throw watchError(cause); }
  }
  configure(snapshot: WatchSnapshot, scopes: readonly WatchScope[]): boolean {
    if (process.platform !== "darwin") return false;
    const paths = watchStreamPaths(snapshot, scopes);
    const key = JSON.stringify(paths);
    if (this.streamPaths === key) return false;
    try { this.binding.watchConfigure!(this.id!, paths.anchors, paths.exclusions); }
    catch (cause) { throw watchError(cause); }
    this.streamPaths = key;
    return true;
  }
  close(): void {
    const id = this.id;
    this.id = undefined; // Fence queued TSFN callbacks before synchronous native join.
    if (id !== undefined) this.binding.watchUnregister!(id);
  }
}

function watchError(cause: unknown): FsSafeError {
  const code = (cause as { code?: string } | null)?.code;
  return new FsSafeError(code === "ENOTSUP" ? "helper-unavailable" : ["ESTALE", "ENOTDIR", "ELOOP"].includes(code ?? "") ? "path-mismatch" : code === "ENOENT" ? "not-found" : "helper-failed", "native watch registration failed", {
    cause, details: { operation: "watch", code },
  });
}
