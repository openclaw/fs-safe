import { createHook } from "node:async_hooks";
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

it("does not remove a file after asynchronous Node removal preparation loses authority", async () => {
  const directory = await tempRoot("fs-safe-remove-dispatch-");
  const target = path.join(directory, "target");
  await fs.writeFile(target, "keep while unauthorized");
  configureFsSafeNative({ mode: "off" });
  const scoped = await root(directory);
  const expired = new Error("removal owner expired during Node preparation");
  let armed = false;
  let revoked = false;
  const preparations = new Set<number>();
  // Node's rm() validates/lstats through callback requests before unlink. Observe
  // their real completion, without replacing either fs.rm() or its filesystem work.
  const hook = createHook({
    init(id, type) {
      if (armed && type === "FSREQCALLBACK") preparations.add(id);
    },
    after(id) {
      if (preparations.has(id)) revoked = true;
    },
  });
  hook.enable();
  let failure: unknown;
  try {
    await scoped.remove("target", {
      assertBeforeMutation: () => {
        if (revoked) throw expired;
        armed = true;
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    hook.disable();
  }
  if (revoked) {
    expect(failure).toBe(expired);
    expect(await fs.readFile(target, "utf8")).toBe("keep while unauthorized");
  } else {
    // Direct unlink submission has no intervening asynchronous preparation.
    expect(failure).toBeUndefined();
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  }
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
  let armed = false;
  let firstWrite: number | undefined;
  let revoked = false;
  // The first admitted request is the actual append write. Revocation happens
  // at its completion, before Node or fs-safe can submit a subsequent chunk.
  const hook = createHook({
    init(id, type) {
      if (armed && firstWrite === undefined && type === "FSREQPROMISE") firstWrite = id;
    },
    after(id) {
      if (id === firstWrite) revoked = true;
    },
  });
  hook.enable();
  let failure: unknown;
  try {
    await scoped.append("target", payload.toString("latin1"), {
      mkdir: false,
      encoding: "latin1",
      prependNewlineIfNeeded: true,
      assertBeforeMutation: () => {
        if (revoked) throw expired;
        armed = true;
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    hook.disable();
  }
  expect(revoked).toBe(true);
  expect(failure).toBe(expired);
  const actual = await fs.readFile(target);
  const expected = Buffer.concat([initial, Buffer.from("\n"), payload]);
  expect(actual.length).toBeGreaterThan(initial.length);
  expect(actual.length).toBeLessThan(expected.length);
  expect(actual).toEqual(expected.subarray(0, actual.length));
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
