import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
});

describe.skipIf(process.platform !== "win32")("Windows JS fallback read-only modes", () => {
  it.each([
    { method: "write", mode: 0o400 },
    { method: "writeJson", mode: 0o400 },
    { method: "create", mode: 0o400 },
    { method: "write", mode: 0o440 },
  ] as const)("$method publishes mode $mode", async ({ method, mode }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-win-fallback-read-only-");
    const target = path.join(directory, "target");
    const safe = await root(directory);
    const content = method === "writeJson" ? '{"value":"payload"}\n' : "payload";

    if (method === "writeJson") {
      await expect(safe.writeJson("target", { value: "payload" }, { mode })).resolves.toBeUndefined();
    } else {
      await expect(safe[method]("target", "payload", { mode })).resolves.toBeUndefined();
    }

    expect(await fs.readFile(target, "utf8")).toBe(content);
    expect((await fs.stat(target)).mode & 0o200).toBe(0);
    expect(await fs.readdir(directory)).toEqual(["target"]);
    await fs.chmod(target, 0o600);
    expect(await fs.readFile(target, "utf8")).toBe(content);

    await expect(safe.write("writable", "payload", { mode: 0o640 })).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(directory, "writable"), "utf8")).toBe("payload");
    expect((await fs.stat(path.join(directory, "writable"))).mode & 0o200).toBe(0o200);
    expect((await fs.readdir(directory)).sort()).toEqual(["target", "writable"]);
  });
});
