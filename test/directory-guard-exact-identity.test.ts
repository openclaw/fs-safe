import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard } from "../src/directory-guard.js";
import { prepareSecretFileWrite } from "../src/secret-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe.each(["capture", "verify", "secret preparation"] as const)("Windows exact directory %s", (stage) => {
  it.each(["transient device", "transient inode", "persistent", "changed known component", "alternating", "symlink"])(
    "retains bounded identity admission: %s",
    async (scenario) => {
      const directory = await tempRoot("fs-safe-directory-exact-");
      const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
      Object.defineProperty(process, "platform", { value: "win32" });
      const lstat = fs.lstat.bind(fs);
      let inspections = 0;
      vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await lstat(...args);
        if (String(args[0]) !== directory) return stat;
        expect(typeof stat.ino).toBe("bigint");
        const attempt = ++inspections;
        const first = attempt === 1;
        if (scenario === "symlink" && !first) return Object.assign(Object.create(stat), { isSymbolicLink: () => true });
        if (scenario === "alternating") return Object.assign(Object.create(stat), first ? { dev: 0n } : { ino: 0n });
        if (scenario === "changed known component" && first) {
          return Object.assign(Object.create(stat), { dev: 0n, ino: guard.stat.ino + 1n });
        }
        if (first || scenario === "persistent") {
          return Object.assign(Object.create(stat), scenario === "transient inode" ? { ino: 0n } : { dev: 0n });
        }
        return stat;
      }) as typeof fs.lstat);
      const pending = stage === "capture" ? createAsyncDirectoryGuard(directory, { bigint: true })
        : stage === "verify" ? assertAsyncDirectoryGuard(guard)
          : prepareSecretFileWrite({ rootDir: directory, filePath: path.join(directory, "secret") });
      if (scenario.startsWith("transient")) {
        await pending;
        expect(inspections).toBeGreaterThanOrEqual(2);
        if (stage !== "secret preparation") expect(inspections).toBe(2);
      } else if (scenario === "symlink") {
        await expect(pending).rejects.toThrow(/directory|symlink/);
        expect(inspections).toBe(2);
      } else {
        await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
        expect(inspections).toBe(stage === "verify" && scenario === "changed known component" ? 1 : 2);
      }
    },
  );
});

it("does not retry an exact guard filesystem failure", async () => {
  const directory = await tempRoot("fs-safe-directory-exact-error-");
  const guard = await createAsyncDirectoryGuard(directory, { bigint: true });
  Object.defineProperty(process, "platform", { value: "win32" });
  const failure = Object.assign(new Error("inspection denied"), { code: "EACCES" });
  const lstat = vi.spyOn(fs, "lstat").mockRejectedValue(failure);
  await expect(assertAsyncDirectoryGuard(guard)).rejects.toBe(failure);
  expect(lstat).toHaveBeenCalledTimes(1);
});
