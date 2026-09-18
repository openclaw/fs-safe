import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const closePositions = ["target", "temporary", "parent"] as const;
const falsyFailures = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "empty string", value: "" },
  { label: "zero bigint", value: 0n },
  { label: "NaN", value: Number.NaN },
] as const;
const closeFailureCases = [
  ...closePositions.flatMap((position, closeIndex) =>
    falsyFailures.map(failure => ({ ...failure, operation: "copyIn" as const, position, closeIndex }))
  ),
  {
    operation: "write" as const,
    position: "target" as const,
    closeIndex: 0,
    label: "undefined",
    value: undefined,
  },
  {
    operation: "create" as const,
    position: "temporary" as const,
    closeIndex: 1,
    label: "null",
    value: null,
  },
];

async function captureRejection(pending: Promise<unknown>) {
  let rejected = false;
  let reason: unknown;
  try {
    await pending;
  } catch (error) {
    rejected = true;
    reason = error;
  }
  return { reason, rejected };
}

describe.skipIf(!native)("Windows native pinned-write close failures", () => {
  it.each(closeFailureCases)(
    "$operation rejects after publication when the $position close throws $label",
    async ({ closeIndex, operation, value }) => {
      // The modeled route runs on every native host; Windows CI exercises the
      // same code with the actual Windows binding and descriptor table.
      Object.defineProperty(process, "platform", { value: "win32" });
      configureFsSafeNative({ mode: "require" });
      const closed: number[] = [];
      __setNativeLoaderForTest(() => ({
        ...native!,
        closeOwnedFd(fd) {
          const index = closed.length;
          closed.push(fd);
          native!.closeOwnedFd(fd);
          if (index === closeIndex) throw value;
        },
      }));

      const directory = await tempRoot("fs-safe-native-falsy-close-");
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      await fs.writeFile(source, "complete source");
      const scoped = await root(directory);

      const pending = operation === "copyIn"
        ? scoped.copyIn("target", source, { durable: false })
        : operation === "create"
          ? scoped.create("target", "complete source", { durable: false })
          : scoped.write("target", "complete source", { durable: false });
      const rejection = await captureRejection(pending);
      expect(rejection.rejected).toBe(true);
      if (operation === "copyIn") {
        expect(rejection.reason).toMatchObject({ code: "invalid-path" });
      } else {
        expect(Object.is(rejection.reason, value)).toBe(true);
      }

      expect(closed).toHaveLength(3);
      expect(new Set(closed).size).toBe(3);
      for (const fd of closed) {
        expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      }
      expect(await fs.readFile(target, "utf8")).toBe("complete source");
      expect(await fs.readFile(source, "utf8")).toBe("complete source");
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
    },
  );
});
