import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validatePinnedOperationPayload } from "../src/pinned-operation.js";
import { configureFsSafeNative, root } from "../src/index.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  Object.defineProperty(process, "platform", platform);
});

it("rejects internal Windows parent components in raw move payloads", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  for (const value of [String.raw`link\..\value`, String.raw`link/..\value`]) {
    expect(() => validatePinnedOperationPayload({ from: value, to: "out" }))
      .toThrowError(expect.objectContaining({ code: "invalid-path" }));
    expect(() => validatePinnedOperationPayload({ from: "in", to: value }))
      .toThrowError(expect.objectContaining({ code: "invalid-path" }));
  }
});

it.each(["write", "create", "append", "openWritable", "copyIn", "move"] as const)(
  "%s rejects a parent traversal whose symlink changes the target",
  async method => {
    const dir = await tempRoot("fs-safe-mutation-parents-");
    await fs.mkdir(path.join(dir, "deep", "dir"), { recursive: true });
    await fs.symlink(path.join(dir, "deep", "dir"), path.join(dir, "link"),
      process.platform === "win32" ? "junction" : "dir");
    const name = method === "create" ? "new" : "value";
    if (method !== "create") {
      await fs.writeFile(path.join(dir, name), "root original");
      await fs.writeFile(path.join(dir, "deep", name), "deep original");
    }
    const source = path.join(dir, "source");
    await fs.writeFile(source, "source bytes");
    configureFsSafeNative({ mode: "off" });
    const scoped = await root(dir);
    const relative = `link${path.sep}..${path.sep}${name}`;
    const pending = method === "openWritable"
      ? scoped.openWritable(relative).then(async opened => { await opened.handle.close(); })
      : method === "copyIn" ? scoped.copyIn(relative, source)
        : method === "move" ? scoped.move(relative, "moved")
        : scoped[method](relative, "new bytes");
    await expect(pending).rejects.toMatchObject({ code: method === "move" ? "invalid-path" : "path-alias" });
    if (method === "create") {
      await expect(fs.stat(path.join(dir, name))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(dir, "deep", name))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(path.join(dir, name), "utf8")).toBe("root original");
      expect(await fs.readFile(path.join(dir, "deep", name), "utf8")).toBe("deep original");
    }
    await scoped.write(`deep${path.sep}dir${path.sep}..${path.sep}plain`, "ordinary parent");
    expect(await fs.readFile(path.join(dir, "deep", "plain"), "utf8")).toBe("ordinary parent");
    if (method === "move") {
      await expect(scoped.move("source", relative)).rejects.toMatchObject({ code: "invalid-path" });
      expect(await fs.readFile(source, "utf8")).toBe("source bytes");
    }
  },
);
