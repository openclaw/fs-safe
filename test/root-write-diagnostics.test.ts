import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root, type Root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const platforms = process.platform === "win32"
  ? [{ name: "Windows", windows: true }]
  : [{ name: "POSIX", windows: false }, { name: "simulated Windows", windows: true }];
const createStream = (scoped: Root) => scoped.create("nested/created", (async function* () {
  yield Buffer.from("replacement");
})());
const routes: Record<string, (scoped: Root, directory: string) => Promise<void>> = {
  write: (scoped) => scoped.write("nested/existing", "replacement"),
  create: (scoped) => scoped.create("nested/created", "replacement"),
  createStream,
  writeJson: (scoped) => scoped.writeJson("nested/existing", { replacement: true }),
  createJson: (scoped) => scoped.createJson("nested/created", { replacement: true }),
  copyIn: (scoped, directory) => scoped.copyIn("nested/created", path.join(directory, "source")),
};

afterEach(() => {
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  Object.defineProperty(process, "platform", platform);
});

async function fixture(error: Error, windows: boolean) {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-write-diagnostics-");
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested/existing"), "original");
  await fs.writeFile(path.join(directory, "source"), "replacement");
  const scoped = await root(directory);
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { throw error; } });
  if (windows) Object.defineProperty(process, "platform", { value: "win32" });
  return { directory, scoped };
}

describe.each(platforms)("pinned write diagnostics: $name", ({ windows }) => {
  // Windows buffered/JSON writes use writeFileFallback, outside this normalization path.
  const platformRoutes = Object.entries(routes).filter(([name]) =>
    !windows || name === "createStream" || name === "copyIn");
  it.each(platformRoutes)("reports the permission cause through %s", async (_name, write) => {
    const cause = Object.assign(new Error("private path must not enter the message"), { code: "EACCES" });
    const { directory, scoped } = await fixture(cause, windows);

    const failure = await write(scoped, directory).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "invalid-path",
      category: "policy",
      message: "permission denied (EACCES)",
      cause,
    });
    expect(failure instanceof Error ? failure.cause : undefined).toBe(cause);
    expect(await fs.readFile(path.join(directory, "nested/existing"), "utf8")).toBe("original");
    expect((await fs.readdir(directory)).sort()).toEqual(["nested", "source"]);
    expect(await fs.readdir(path.join(directory, "nested"))).toEqual(["existing"]);
  });

  it.each([
    ["EPERM", "permission denied (EPERM)"],
    ["EROFS", "read-only filesystem (EROFS)"],
    ["ENOSPC", "no space left on device (ENOSPC)"],
    ["EIO", "filesystem write failed (EIO)"],
  ])("describes the underlying %s failure", async (code, message) => {
    const cause = Object.assign(new Error("private syscall diagnostic"), { code });
    const { scoped } = await fixture(cause, windows);
    await expect(createStream(scoped)).rejects.toMatchObject({
      code: "invalid-path", category: "policy", message, cause,
    });
  });

  it("preserves an already-classified boundary error and its details", async () => {
    const error = new FsSafeError("symlink", "classified failure", {
      cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      details: { boundary: "owned" },
    });
    const { scoped } = await fixture(error, windows);
    await expect(createStream(scoped)).rejects.toBe(error);
  });
});
