import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch } from "../src/watch.js";

const state = vi.hoisted(() => ({ created: 0, closed: 0, physical: [] as string[] }));
// Isolate owner bookkeeping from the OS. Real recursive runtime and parser
// qualification lives in watch.test/native-paths/worker-program and hosted CI.
vi.mock("../src/watch-node.js", () => ({ NodeWatchBackend: class {
  readonly recursiveRoot = true;
  private closing?: Promise<void>;
  constructor() { state.created++; }
  async add(_absolute: string, relative: string) { if (!relative) state.physical.push(relative); }
  directoryCount() { return this.closing ? 0 : 1; }
  async drainCommands() {}
  close() { return this.closing ??= Promise.resolve().then(() => { state.closed++; }); }
} }));

it("keeps physical Root ownership distinct from guarded descendant inventory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-ownership-"));
  const owner = watch(await root(directory), { scopes: [{ path: "a/b", kind: "tree" }], onDirty() {} });
  try {
    await owner.ready;
    await fs.mkdir(path.join(directory, "a/b"), { recursive: true });
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ directories: 1, observedDirectories: 3 });
    await fs.rename(path.join(directory, "a"), path.join(directory, "old"));
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ directories: 1, observedDirectories: 1 });
    await fs.mkdir(path.join(directory, "a/b"), { recursive: true });
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ directories: 1, observedDirectories: 3 });
    expect({ ...state, physical: [...state.physical] }).toEqual({ created: 1, closed: 0, physical: [""] });
  } finally { await owner.close(); await fs.rm(directory, { recursive: true, force: true }); }
  expect(state.closed).toBe(1);
  expect(owner.health()).toMatchObject({ directories: 0, observedDirectories: 0, workers: 0 });
});
