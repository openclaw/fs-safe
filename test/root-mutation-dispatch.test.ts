import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

it("submits removal before authority can expire in a later microtask", async () => {
  const directory = await tempRoot("fs-safe-remove-dispatch-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "keep while unauthorized");
  configureFsSafeNative({ mode: "off" });
  const scoped = await root(directory);
  const expired = new Error("removal owner expired before dispatch");
  let revoked = false;
  let dispatched = false;
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation((filePath) => {
    expect(revoked).toBe(false);
    dispatched = true;
    return unlink(filePath);
  });
  await scoped.remove("target", {
    assertBeforeMutation: () => {
      if (revoked) throw expired;
      queueMicrotask(() => { revoked = true; });
    },
  });
  expect(dispatched).toBe(true);
  expect(revoked).toBe(true);
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("stops a large append when authority expires after its first filesystem write", async () => {
  const directory = await tempRoot("fs-safe-append-dispatch-");
  const target = path.join(directory, "target");
  const initial = Buffer.from("original");
  const payload = Buffer.alloc(1024 * 1024, 0xe9);
  await fs.writeFile(target, initial);
  configureFsSafeNative({ mode: "off" });
  const scoped = await root(directory);
  const expired = new Error("append owner expired after the first write");
  let revoked = false;
  // Revoke from completed filesystem state, independently of the runtime's
  // async request types or the append implementation's chunk size.
  await expect(scoped.append("target", payload.toString("latin1"), {
    mkdir: false,
    encoding: "latin1",
    prependNewlineIfNeeded: true,
    assertBeforeMutation: () => {
      if (fsSync.statSync(target).size > initial.length) {
        revoked = true;
        throw expired;
      }
    },
  })).rejects.toBe(expired);
  expect(revoked).toBe(true);
  const actual = await fs.readFile(target);
  const expected = Buffer.concat([initial, Buffer.from("\n"), payload]);
  expect(actual.length).toBeGreaterThan(initial.length);
  expect(actual.length).toBeLessThan(expected.length);
  expect(actual.equals(expected.subarray(0, actual.length))).toBe(true);
});

it("rechecks empty append cleanup identity after its awaited parent guard", async () => {
  const directory = await tempRoot("fs-safe-append-cleanup-dispatch-");
  const target = path.join(directory, "new");
  configureFsSafeNative({ mode: "off" });
  const scoped = await root(directory);
  const expired = new Error("append owner expired");
  let refused = false;
  let observedLeaf = false;
  let replaced = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const stat = lstat(...args);
    if (refused && String(args[0]) === target) observedLeaf = true;
    if (refused && observedLeaf && !replaced && String(args[0]) === directory && fsSync.existsSync(target)) {
      fsSync.renameSync(target, path.join(directory, "saved"));
      fsSync.writeFileSync(target, "replacement");
      replaced = true;
    }
    return stat;
  }) as typeof fsSync.lstatSync);
  await expect(scoped.append("new", "content", {
    assertBeforeMutation: () => {
      if (fsSync.existsSync(target)) { refused = true; throw expired; }
    },
  })).rejects.toBe(expired);
  if (replaced) expect(await fs.readFile(target, "utf8")).toBe("replacement");
  else await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps the file created by a successful empty append", async () => {
  const directory = await tempRoot("fs-safe-empty-append-");
  const scoped = await root(directory);
  await scoped.append("empty", "");
  expect(await fs.readFile(path.join(directory, "empty"))).toEqual(Buffer.alloc(0));
});
