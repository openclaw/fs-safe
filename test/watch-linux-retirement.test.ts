import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";
import { watchDiagnostics } from "./helpers/watch-diagnostics.js";

const native = !!watchBinding("auto");
if (process.platform === "linux" && process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !native) throw new Error("Linux retirement proof requires the source-built binding");
const linux = it.skipIf(process.platform !== "linux" || !native);
let fixture: string | undefined;
const owners: WatchSubscription[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  vi.restoreAllMocks();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

linux.each(["close", "scan failure"])("keeps an unrelated Root healthy after TREE retirement (%s)", async operation => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), "watch-linux-retire-"));
  const left = path.join(fixture, "left"), right = path.join(fixture, "right");
  await fs.mkdir(left); await fs.mkdir(right);
  await fs.writeFile(path.join(left, "config.json"), "before");
  const values: WatchInvalidation[] = [];
  const diagnostics = watchDiagnostics("config.json");
  const a = watch(await root(left), { mode: "events", scopes: [{ path: "config.json", kind: "entry" }], intervalMs: 60_000,
    onInvalidate: value => { values.push(value); diagnostics.invalidation(value); } });
  owners.push(a); await a.ready;
  const b = watch(await root(right), { mode: "events", scopes: [{ path: "", kind: "tree" }], intervalMs: 60_000, onInvalidate() {} });
  owners.push(b); await b.ready;
  await diagnostics.quiet(a); values.length = 0;
  if (operation === "scan failure") {
    const invalid = Buffer.concat([Buffer.from(right + "/"), Buffer.from([0xff])]);
    await fs.writeFile(invalid, "invalid name");
    await expect(b.reconcile()).rejects.toMatchObject({ code: "invalid-path" });
    expect(b.health()).toMatchObject({ state: "unavailable", failure: { operation: "scan", code: "invalid-path" } });
  }
  await b.close();
  await diagnostics.quiet(a);
  expect(a.health()).toMatchObject({ state: "ready", mode: "events" });
  expect(values).toEqual([]);
  await fs.writeFile(path.join(left, "config.json"), "still observed");
  await a.reconcile(); await diagnostics.quiet(a);
  expect(values.some(value => value.changes?.some(change => change.path === "config.json"))).toBe(true);
  expect(values.filter(value => value.reason === "overflow")).toEqual([]);
}, 30_000);
