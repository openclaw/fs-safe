import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { resolveRootContext } from "../src/root-context.js";
import { verifyAtomicWriteResult } from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

async function fixture() {
  const directory = await tempRoot("fs-safe-verification-receipt-");
  const targetPath = path.join(directory, "target");
  await fs.writeFile(targetPath, "payload");
  const root = await resolveRootContext(directory);
  const parentGuard = await createAsyncDirectoryGuard(directory, { bigint: true });
  const handle = await fs.open(targetPath, "r+");
  const expectedIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
  return { directory, handle, params: { root, parentGuard, targetPath, fd: handle.fd, expectedIdentity } };
}

describe("Root publication resolver receipts", () => {
  it.each(["known", "lstat", "resolver"])("samples once per pass with fresh final checks (opaque source=%s)", async source => {
    const { directory, handle, params } = await fixture();
    // Exercise the pathname resolver and Windows reopen branch on every host.
    Object.defineProperty(process, "platform", { value: "win32" });
    const opaque = source !== "known";
    const statSync = fsSync.statSync.bind(fsSync);
    const stat = vi.spyOn(fsSync, "statSync").mockImplementation(((...args: Parameters<typeof fsSync.statSync>) => {
      const actual = statSync(...args);
      return source === "resolver" && String(args[0]) === params.targetPath
        ? Object.assign(Object.create(actual), { dev: 0n, ino: 0n }) : actual;
    }) as typeof fsSync.statSync);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const sampled = vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const actual = lstat(...args);
      if (source !== "lstat" || String(args[0]) !== params.targetPath) return actual;
      return Object.assign(Object.create(actual), { dev: 0n, ino: 0n });
    }) as typeof fsSync.lstatSync);
    const descriptor = vi.spyOn(fsSync, "fstatSync");
    const opened = vi.spyOn(fs, "open");
    try {
      for (let operation = 1; operation <= 2; operation++) {
        await expect(verifyAtomicWriteResult(params)).resolves.toBeUndefined();
        const passes = operation * (opaque ? 2 : 1);
        expect(stat.mock.calls.filter(([candidate]) => candidate === params.targetPath)).toHaveLength(passes);
        expect(sampled.mock.calls.filter(([candidate]) => candidate === params.targetPath)).toHaveLength(passes * 2);
        expect(sampled.mock.calls.filter(([candidate]) => candidate === directory)).toHaveLength(passes * 2);
        expect(descriptor.mock.calls.filter(([fd]) => fd === handle.fd)).toHaveLength(operation * 2);
        expect(opened.mock.calls.filter(([candidate]) => candidate === params.targetPath)).toHaveLength(opaque ? operation : 0);
      }
    } finally {
      await handle.close();
    }
  });

  it.each(["pathname identity", "hardlink", "descriptor identity"])(
    "rejects a late %s change after consuming the resolver receipt", async change => {
      const { directory, handle, params } = await fixture();
      Object.defineProperty(process, "platform", { value: "win32" });
      const lstat = fsSync.lstatSync.bind(fsSync);
      const fstat = fsSync.fstatSync.bind(fsSync);
      let late = false;
      const changedStat = (stat: BigIntStats) => Object.assign(Object.create(stat),
        change === "hardlink" ? { nlink: 2n } : { ino: stat.ino + 1n });
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
        const actual = lstat(...args);
        // The first parent check runs after canonical resolution. Change only
        // subsequent observations so the final checks must catch the change.
        if (String(args[0]) === directory) late = true;
        return late && String(args[0]) === params.targetPath && change !== "descriptor identity"
          ? changedStat(actual as BigIntStats) : actual;
      }) as typeof fsSync.lstatSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
        const actual = fstat(...args);
        return late && args[0] === handle.fd && change === "descriptor identity"
          ? changedStat(actual as BigIntStats) : actual;
      }) as typeof fsSync.fstatSync);
      try {
        await expect(verifyAtomicWriteResult(params)).rejects.toMatchObject({
          code: change === "hardlink" ? "hardlink" : "path-mismatch",
        });
        expect(late).toBe(true);
      } finally {
        await handle.close();
      }
    },
  );
});
