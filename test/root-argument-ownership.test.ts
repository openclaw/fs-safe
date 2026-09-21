import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root, type Root, type RootCopyOptions, type RootOpenOptions, type RootWriteOptions } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const modes = nativeAvailable ? ["off", "require"] as const : ["off"] as const;
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

const operations = ["open", "openWritable", "write", "create", "append", "remove", "mkdir", "ensureRoot", "copyIn"] as const;
type Operation = typeof operations[number];
type CallOptions = RootWriteOptions & RootCopyOptions & RootOpenOptions;

async function invoke(scoped: Root, operation: Operation, relativePath: string, options: CallOptions, source: string) {
  if (operation === "open" || operation === "openWritable") {
    await using opened = await scoped[operation](relativePath, options);
    return opened.realPath;
  }
  if (operation === "write" || operation === "create" || operation === "append") {
    return await scoped[operation](relativePath, "argument", options);
  }
  if (operation === "ensureRoot") return await scoped.ensureRoot(options);
  if (operation === "copyIn") return await scoped.copyIn(relativePath, source, options);
  return await scoped[operation](relativePath, options);
}

describe.each(modes)("Root argument ownership (native %s)", mode => {
  async function fixture() {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-root-arguments-");
    const sourceDirectory = path.join(directory, "source");
    const destinationDirectory = path.join(directory, "destination");
    await fs.mkdir(sourceDirectory);
    await fs.mkdir(destinationDirectory);
    const sourcePath = path.join(sourceDirectory, "input");
    await fs.writeFile(sourcePath, "source bytes");
    await fs.writeFile(path.join(sourceDirectory, "alternate"), "other source");
    await fs.writeFile(path.join(destinationDirectory, "decoy"), "untouched");
    return {
      sourceDirectory, sourcePath, destinationDirectory,
      scoped: await root(destinationDirectory, { durable: false }),
      read: (name: string) => fs.readFile(path.join(destinationDirectory, name), "utf8"),
      names: async () => (await fs.readdir(destinationDirectory)).sort(),
    };
  }

  it.each(["write", "create", "append"] as const)("%s owns its positional path and bytes", async operation => {
    const f = await fixture();
    if (operation !== "create") await fs.writeFile(path.join(f.destinationDirectory, "target"), "before:");
    const options = { relativePath: "decoy", data: "injected", durable: false };
    await f.scoped[operation]("target", "argument", options);
    expect(await f.read("target")).toBe(operation === "append" ? "before:argument" : "argument");
    expect(await f.read("decoy")).toBe("untouched");
    expect(await f.names()).toEqual(["decoy", "target"]);
  });

  it.each(["writeJson", "createJson"] as const)("%s keeps its serialized positional value", async operation => {
    const f = await fixture();
    const options = { relativePath: "decoy", data: "injected", space: 0, trailingNewline: false, durable: false };
    await f.scoped[operation]("target", { selected: true }, options);
    expect(await f.read("target")).toBe('{"selected":true}');
    expect(await f.read("decoy")).toBe("untouched");
    expect(await f.names()).toEqual(["decoy", "target"]);
  });

  it("streamed create consumes and closes the positional producer", async () => {
    const f = await fixture();
    let closed = false;
    async function* input() {
      try { yield Buffer.from("selected"); } finally { closed = true; }
    }
    const options = { relativePath: "decoy", data: Buffer.from("injected"), maxBytes: 8, durable: false };
    await f.scoped.create("target", input(), options);
    expect(closed).toBe(true);
    expect(await f.read("target")).toBe("selected");
    expect(await f.read("decoy")).toBe("untouched");
    expect(await f.names()).toEqual(["decoy", "target"]);
  });

  it.each(["open", "read", "readBytes", "readText", "readJson", "readAbsolute", "reader"] as const)(
    "%s reads the selected path with a wider options object", async operation => {
      const f = await fixture();
      const contents = '{"selected":true}';
      await fs.writeFile(path.join(f.destinationDirectory, "target"), contents);
      const options = { relativePath: "decoy", hardlinks: "reject" as const };
      let actual: unknown;
      if (operation === "open") {
        await using opened = await f.scoped.open("target", options);
        actual = await opened.handle.readFile("utf8");
      } else if (operation === "reader") {
        actual = (await f.scoped.reader(options)(path.join(f.destinationDirectory, "target"))).toString();
      } else if (operation === "readAbsolute") {
        actual = (await f.scoped.readAbsolute(path.join(f.destinationDirectory, "target"), options)).buffer.toString();
      } else if (operation === "read") {
        actual = (await f.scoped.read("target", options)).buffer.toString();
      } else if (operation === "readBytes") {
        actual = (await f.scoped.readBytes("target", options)).toString();
      } else actual = await f.scoped[operation]("target", options);
      expect(actual).toEqual(operation === "readJson" ? { selected: true } : contents);
      expect(await f.read("decoy")).toBe("untouched");
    },
  );

  it.each(["replace", "append", "update"] as const)("openWritable keeps the public %s mode and ignores helper overrides", async writeMode => {
    const f = await fixture();
    await fs.writeFile(path.join(f.destinationDirectory, "target"), "before");
    const options = {
      relativePath: "decoy", expectedWritePath: path.join(f.destinationDirectory, "decoy"),
      append: writeMode !== "append", truncateExisting: writeMode !== "replace", writeMode,
    };
    {
      await using opened = await f.scoped.openWritable("target", options);
      expect(opened.realPath).toBe(path.join(f.destinationDirectory, "target"));
      await opened.handle.writeFile("new");
    }
    expect(await f.read("target")).toBe(writeMode === "replace" ? "new" : writeMode === "append" ? "beforenew" : "newore");
    expect(await f.read("decoy")).toBe("untouched");
  });

  it("openWritable ignores a foreign expectedWritePath without redirecting or rejecting its target", async () => {
    const f = await fixture();
    const options = { expectedWritePath: path.join(f.destinationDirectory, "decoy"), writeMode: "replace" as const };
    {
      await using opened = await f.scoped.openWritable("target", options);
      await opened.handle.writeFile("selected");
    }
    expect(await f.read("target")).toBe("selected");
    expect(await f.read("decoy")).toBe("untouched");
  });

  it("remove deletes only its positional path", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.destinationDirectory, "target"), "selected");
    const options = { relativePath: "decoy", force: false };
    await f.scoped.remove("target", options);
    expect(await f.names()).toEqual(["decoy"]);
    expect(await f.read("decoy")).toBe("untouched");
  });

  it("mkdir projects its own path and resolver flags", async () => {
    const f = await fixture();
    const observeRoot = vi.fn(() => { throw new Error("foreign removal receipt"); });
    const options = {
      relativePath: "decoy", allowRoot: true, remove: true, removalReceipts: { observeRoot }, private: false,
    };
    await f.scoped.mkdir("target", options);
    expect((await fs.stat(path.join(f.destinationDirectory, "target"))).isDirectory()).toBe(true);
    expect(observeRoot).not.toHaveBeenCalled();
    expect(await f.read("decoy")).toBe("untouched");
  });

  it("mkdir cannot acquire ensureRoot semantics through an allowRoot field", async () => {
    const f = await fixture();
    const options = { allowRoot: true, private: false };
    await expect(f.scoped.mkdir(".", options)).rejects.toMatchObject({ code: "outside-workspace" });
    expect(await f.names()).toEqual(["decoy"]);
  });

  it.each(["relativePath", "allowRoot", "removalReceipts"] as const)("ensureRoot owns its %s helper input", async field => {
    const f = await fixture();
    const observeRoot = vi.fn(() => { throw new Error("foreign removal receipt"); });
    const options = {
      private: false,
      ...(field === "relativePath" ? { relativePath: "injected" } :
        field === "allowRoot" ? { allowRoot: false } : { remove: true, removalReceipts: { observeRoot } }),
    };
    await f.scoped.ensureRoot(options);
    expect(observeRoot).not.toHaveBeenCalled();
    expect(await f.names()).toEqual(["decoy"]);
  });

  it("copyIn keeps its positional destination and absolute source", async () => {
    const f = await fixture();
    const options = { relativePath: "decoy", source: path.join(f.sourceDirectory, "alternate"), durable: false };
    await f.scoped.copyIn("target", f.sourcePath, options);
    expect(await f.read("target")).toBe("source bytes");
    expect(await f.read("decoy")).toBe("untouched");
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe("source bytes");
  });

  it("copyIn uses the scoped source's open and stat with the explicit hardlink policy", async () => {
    const f = await fixture();
    const source = await root(f.sourceDirectory, { hardlinks: "reject" });
    const open = vi.fn((...args: Parameters<Root["open"]>) => source.open(...args));
    const stat = vi.fn((...args: Parameters<Root["stat"]>) => source.stat(...args));
    const options = {
      relativePath: "decoy", source: path.join(f.sourceDirectory, "alternate"),
      sourceHardlinks: "allow" as const, durable: false,
    };
    await f.scoped.copyIn("target", { root: { open, stat }, relativePath: "input" }, options);
    expect(open).toHaveBeenCalledExactlyOnceWith("input", { hardlinks: "allow" });
    expect(stat).toHaveBeenCalledWith(".");
    expect(await f.read("target")).toBe("source bytes");
    expect(await f.read("decoy")).toBe("untouched");
  });

  it.each([undefined, "allow", "reject"] as const)("copyIn retains sourceHardlinks=%s controls", async sourceHardlinks => {
    const f = await fixture();
    await fs.link(f.sourcePath, path.join(f.sourceDirectory, "alias"));
    const source = await root(f.sourceDirectory, { hardlinks: "reject" });
    const options = { relativePath: "decoy", source: path.join(f.sourceDirectory, "alternate"), sourceHardlinks, durable: false };
    const pending = f.scoped.copyIn("target", { root: source, relativePath: "input" }, options);
    if (sourceHardlinks === "allow") {
      await pending;
      expect(await f.read("target")).toBe("source bytes");
    } else {
      await expect(pending).rejects.toMatchObject({ code: "hardlink" });
      expect(await f.names()).toEqual(["decoy"]);
    }
    expect(await f.read("decoy")).toBe("untouched");
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe("source bytes");
  });

  it("copyIn snapshots the scoped source before reading the default byte budget", async () => {
    const f = await fixture();
    const selected = { root: await root(f.sourceDirectory), relativePath: "input" };
    let copying = false;
    const scoped = await root(f.destinationDirectory, {
      durable: false,
      get maxBytes() { if (copying) selected.relativePath = "alternate"; return 1024; },
    });
    copying = true;
    await scoped.copyIn("target", selected);
    expect(selected.relativePath).toBe("alternate");
    expect(await f.read("target")).toBe("source bytes");
  });

  it("observes collision getters without granting them positional ownership", async () => {
    const f = await fixture();
    const reads: string[] = [];
    const options = {
      get relativePath() { reads.push("relativePath"); return "decoy"; },
      get data() { reads.push("data"); return "injected"; },
      durable: false,
    };
    await f.scoped.write("target", "argument", options);
    expect(reads).toEqual(["relativePath", "data"]);
    expect(await f.read("target")).toBe("argument");
    expect(await f.read("decoy")).toBe("untouched");
  });

  it.each(operations)("%s preserves a throwing enumerable getter before filesystem mutation", async operation => {
    const f = await fixture();
    await fs.writeFile(path.join(f.destinationDirectory, "target"), "selected");
    const failure = new Error("enumerable option rejected");
    const reads: string[] = [];
    const options = {
      get relativePath() { reads.push("relativePath"); return "decoy"; },
      get data() { reads.push("data"); throw failure; },
      durable: false, hardlinks: "reject" as const,
    };
    await expect(invoke(f.scoped, operation, "target", options, f.sourcePath)).rejects.toBe(failure);
    expect(reads).toEqual(["relativePath", "data"]);
    expect(await f.read("target")).toBe("selected");
    expect(await f.read("decoy")).toBe("untouched");
    expect(await f.names()).toEqual(["decoy", "target"]);
  });

  it.each(["write", "create", "append", "remove", "mkdir", "openWritable", "copyIn"] as const)(
    "%s rejects an invalid positional path before collision getters", async operation => {
      const f = await fixture();
      const readCollision = vi.fn(() => { throw new Error("collision getter must not run"); });
      const options = { get relativePath() { return readCollision(); }, durable: false };
      await expect(invoke(f.scoped, operation, "bad\0path", options, f.sourcePath)).rejects.toMatchObject({ code: "invalid-path" });
      expect(readCollision).not.toHaveBeenCalled();
      expect(await f.names()).toEqual(["decoy"]);
    },
  );

  it("open cannot replace an invalid positional path with a valid option field", async () => {
    const f = await fixture();
    const options = { relativePath: "decoy", hardlinks: "reject" as const };
    await expect(invoke(f.scoped, "open", "bad\0path", options, f.sourcePath)).rejects.toMatchObject({ code: "invalid-path" });
    expect(await f.names()).toEqual(["decoy"]);
  });

  it.each(["copyIn", "stream"] as const)("%s preserves initial cancellation before reading collision getters", async operation => {
    const f = await fixture();
    const failure = new Error("already cancelled");
    const readCollision = vi.fn(() => { throw new Error("collision getter must not run"); });
    const options = { signal: AbortSignal.abort(failure), get relativePath() { return readCollision(); }, durable: false };
    async function* input() { yield Buffer.from("selected"); }
    const pending = operation === "copyIn" ? f.scoped.copyIn("target", f.sourcePath, options)
      : f.scoped.create("target", input(), options);
    await expect(pending).rejects.toBe(failure);
    expect(readCollision).not.toHaveBeenCalled();
    expect(await f.names()).toEqual(["decoy"]);
  });
});
