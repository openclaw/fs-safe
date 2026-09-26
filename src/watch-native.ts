import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { RootContext } from "./root-context.js";
import type { DirectoryIdentity } from "./watch-scan.js";

export type NativeWatchHint = { directory: string; name: string; event: "rename" | "change" };
export type NativeWatchBatch = { hints: NativeWatchHint[]; overflow: boolean };
export type NativeWatchWireBatch = { hints: { directory: string; name: string; structural: boolean }[]; overflow: boolean };
export function watchBinding(mode: "auto" | "events" | "poll"): NativeBinding | undefined {
  if (mode === "poll") return;
  const binding = getNativeBinding(); // Preserves require + missing-addon failure.
  // macOS/Windows transport and Bun TSFN teardown are not yet qualified.
  // Their guarded native scans remain usable in polling mode.
  if (binding?.watchRegister && !process.versions.bun && !process.versions.deno && process.platform === "linux") return binding;
  if (mode === "events" || getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "native watch events are unavailable", { details: { operation: "watch" } });
  }
}
export class NativeWatchBackend {
  private id: number | undefined;
  constructor(private binding: NativeBinding, private root: RootContext, callback: (batch: NativeWatchBatch) => void, limit: number) {
    try { this.id = binding.watchRegister!(root.rootReal, limit, batch => {
      if (this.id !== undefined) callback({ overflow: batch.overflow, hints: batch.hints.map(hint => ({
        directory: hint.directory, name: hint.name, event: hint.structural ? "rename" : "change",
      })) });
    }); } catch (cause) { throw watchError(cause); }
  }
  add(name: string, identity: DirectoryIdentity): void {
    try {
      this.binding.watchAdd!(this.id!, this.root.rootReal, name,
        BigInt(this.root.rootIdentity.dev), BigInt(this.root.rootIdentity.ino), identity.dev, identity.ino);
    } catch (cause) {
      throw watchError(cause);
    }
  }
  close(): void {
    const id = this.id;
    this.id = undefined; // Fence queued TSFN callbacks before synchronous native join.
    if (id !== undefined) this.binding.watchUnregister!(id);
  }
}

function watchError(cause: unknown): FsSafeError {
  const code = (cause as { code?: string } | null)?.code;
  return new FsSafeError(code === "ENOTSUP" ? "helper-unavailable" : code === "ESTALE" ? "path-mismatch" : code === "ENOENT" ? "not-found" : "helper-failed", "native watch registration failed", {
    cause, details: { operation: "watch", code },
  });
}
