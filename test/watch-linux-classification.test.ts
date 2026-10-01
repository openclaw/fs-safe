import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watchBinding, type NativeWatchWireBatch } from "../src/watch-native.js";
import { watch, type WatchInvalidation, type WatchScope, type WatchSubscription } from "../src/watch.js";
import { watchDiagnostics } from "./helpers/watch-diagnostics.js";

const native = !!watchBinding("auto");
if (process.platform === "linux" && process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !native) throw new Error("Linux classification proof requires the source-built binding");
const linux = it.skipIf(process.platform !== "linux" || !native);
let fixture: string;
const owners: WatchSubscription[] = [];
beforeEach(async () => { fixture = await fs.mkdtemp(path.join(os.tmpdir(), "watch-linux-names-")); });
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  vi.restoreAllMocks();
  await fs.rm(fixture, { recursive: true, force: true });
});
async function observe(scopes: WatchScope[]) {
  const batches: NativeWatchWireBatch[] = [], values: WatchInvalidation[] = [];
  const diagnostics = watchDiagnostics("", batch => { batches.push(batch); });
  const owner = watch(await root(fixture), { mode: "events", scopes, intervalMs: 60_000,
    onInvalidate: value => { values.push(value); diagnostics.invalidation(value); } });
  owners.push(owner); await owner.ready; await diagnostics.quiet(owner);
  batches.length = 0; values.length = 0;
  return { owner, batches, values, quiet: () => diagnostics.quiet(owner) };
}
const malformed = (directory: string) => Buffer.concat([Buffer.from(directory + path.sep), Buffer.from([0xff])]);

linux("ignores undecodable siblings beside a missing TREE anchor without overflow", async () => {
  await fs.mkdir(path.join(fixture, "anchor"));
  const { owner, batches, values, quiet } = await observe([{ path: "anchor/missing", kind: "tree", depth: 2 }]);
  const invalid = malformed(path.join(fixture, "anchor"));
  for (const create of [true, false]) {
    batches.length = 0;
    if (create) await fs.writeFile(invalid, "unselected"); else await fs.unlink(invalid);
    await expect.poll(() => batches.some(batch => batch.hints.some(hint => hint.namelessChild && hint.directory === "anchor"))).toBe(true);
    await owner.reconcile(); await quiet();
    expect(batches.every(batch => !batch.overflow)).toBe(true);
    expect(values).toEqual([]);
    expect(owner.health().state).toBe("ready");
  }
  await fs.mkdir(path.join(fixture, "anchor/missing"));
  await fs.writeFile(path.join(fixture, "anchor/missing/valid"), "selected");
  await owner.reconcile(); await quiet();
  expect(values.some(value => value.changes?.some(change => change.path === "anchor/missing/valid"))).toBe(true);
  expect(values.every(value => value.reason !== "overflow")).toBe(true);
});

linux("fails closed on an undecodable selected TREE child without backend overflow", async () => {
  await fs.mkdir(path.join(fixture, "selected"));
  const { owner, batches, values } = await observe([{ path: "selected", kind: "tree", depth: 1 }]);
  await fs.writeFile(malformed(path.join(fixture, "selected")), "selected invalid name");
  await expect.poll(() => batches.some(batch => batch.hints.some(hint => hint.namelessChild && hint.directory === "selected"))).toBe(true);
  await expect(owner.reconcile()).rejects.toMatchObject({ code: "invalid-path" });
  expect(owner.health()).toMatchObject({ state: "unavailable", failure: { code: "invalid-path", operation: "scan" } });
  expect(batches.every(batch => !batch.overflow)).toBe(true);
  expect(values).toEqual([]);
});

linux.each(["chmod", "rename", "delete"])("keeps structural detail for a watched directory %s", async operation => {
  await fs.mkdir(path.join(fixture, "child"));
  const { owner, batches, values, quiet } = await observe([{ path: "", kind: "tree", depth: 2 }]);
  if (operation === "chmod") await fs.chmod(path.join(fixture, "child"), 0o700);
  if (operation === "rename") await fs.rename(path.join(fixture, "child"), path.join(fixture, "renamed"));
  if (operation === "delete") await fs.rmdir(path.join(fixture, "child"));
  await expect.poll(() => batches.length).toBeGreaterThan(0);
  await owner.reconcile(); await quiet();
  expect(batches.every(batch => !batch.overflow)).toBe(true);
  expect(values.some(value => value.changes?.some(change => change.path === "child" && change.type === "structural"))).toBe(true);
  expect(values.every(value => value.reason !== "overflow" && value.changes !== undefined)).toBe(true);
});
