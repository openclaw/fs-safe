import { expect, it, vi } from "vitest";
import type { NativeBinding } from "../src/native.js";
import type { RootContext } from "../src/root-context.js";
import { NativeWatchBackend } from "../src/watch-native.js";
import type { WatchSnapshot } from "../src/watch-scan.js";

it.each(["linux", "win32"])("does not prepare FSEvents paths on %s", platform => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  const configure = vi.fn();
  const backend = new NativeWatchBackend({ watchRegister: () => 1, watchConfigure: configure, watchUnregister() {} } as unknown as NativeBinding,
    { rootReal: "/synthetic" } as RootContext, () => {}, 256, false);
  try {
    Object.defineProperty(process, "platform", { value: platform });
    const snapshot = { get directoryPaths() { throw new Error("FSEvents path preparation"); } } as WatchSnapshot;
    expect(backend.configure(snapshot, [{ path: "tree", kind: "tree", depth: 8 }])).toBe(false);
    expect(configure).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", original);
    backend.close();
  }
});
