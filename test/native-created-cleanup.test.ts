import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeNativeCreatedFileIfStillPinned } from "../src/native-operations.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe("native created-file cleanup authority", () => {
  it.each(["matching", "parent-path", "parent-fd", "target", "created"])(
    "handles Windows identity observation: %s",
    async (scenario) => {
      const parentPath = await tempRoot("fs-safe-native-cleanup-identity-");
      const targetPath = path.join(parentPath, "target");
      await fs.writeFile(targetPath, "owned", { mode: 0o600 });
      const created = await fs.lstat(targetPath, { bigint: true });
      const parent = await fs.open(parentPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
      Object.defineProperty(process, "platform", { value: "win32" });
      const lstat = fsSync.lstatSync.bind(fsSync);
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
        const stat = lstat(...args);
        const selected = scenario === "parent-path" ? parentPath : scenario === "target" ? targetPath : undefined;
        return String(args[0]) === selected ? Object.assign(Object.create(stat), { ino: 0n }) : stat;
      }) as typeof fsSync.lstatSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
        const stat = fstat(...args);
        return scenario === "parent-fd" && args[0] === parent.fd
          ? Object.assign(Object.create(stat), { ino: 0n }) : stat;
      }) as typeof fsSync.fstatSync);
      try {
        removeNativeCreatedFileIfStillPinned({
          parentPath, parentFd: parent.fd, basename: "target",
          created: scenario === "created" ? Object.assign(Object.create(created), { ino: 0n }) : created,
        });
        expect(fsSync.existsSync(targetPath)).toBe(scenario !== "matching");
        if (scenario !== "matching") expect(await fs.readFile(targetPath, "utf8")).toBe("owned");
      } finally {
        await parent.close();
      }
    },
  );
});
