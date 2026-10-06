import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const native = loadTestNative("optional");
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

describe.skipIf(!native || process.platform === "win32")("unsupported native no-replace publication", () => {
  it.each(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("retries auto create after %s without clobbering or leaving a stage", async code => {
    configureFsSafeNative({ mode: "auto" });
    const directory = await tempRoot("fs-safe-noreplace-fallback-");
    const rename = vi.fn(() => { throw Object.assign(new Error("rename without replacement"), { code }); });
    const remove = vi.fn(native!.removeStagedFile);
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename, removeStagedFile: remove }));
    const scoped = await root(directory);
    await scoped.create("target", "complete content");
    expect(await scoped.readText("target")).toBe("complete content");
    expect(remove).toHaveBeenCalledOnce();
    await expect(scoped.create("target", "clobber")).rejects.toMatchObject({ code: "already-exists" });
    await scoped.create("next", "next content");
    expect(rename).toHaveBeenCalledOnce();
    configureFsSafeNative({ mode: "require" });
    await expect(scoped.create("required", "content")).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(rename).toHaveBeenCalledOnce();
    expect((await fs.readdir(directory)).sort()).toEqual(["next", "target"]);
    expect(await scoped.readText("target")).toBe("complete content");
  });

  it("replays completed streamed bytes without consuming the producer twice", async () => {
    configureFsSafeNative({ mode: "auto" });
    const directory = await tempRoot("fs-safe-noreplace-fallback-");
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      throw Object.assign(new Error("rename without replacement"), { code: "EINVAL" });
    } }));
    const scoped = await root(directory);
    let pulls = 0;
    await scoped.create("stream", (async function* () {
      pulls++;
      yield Buffer.from("first ");
      yield Buffer.from("second");
    })());
    expect(pulls).toBe(1);
    expect(await scoped.readText("stream")).toBe("first second");
    expect(await fs.readdir(directory)).toEqual(["stream"]);
  });

  it("requires native capability and cleans the definitely unpublished stage", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-noreplace-fallback-");
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      throw Object.assign(new Error("rename without replacement"), { code: "EINVAL" });
    } }));
    await expect((await root(directory)).create("target", "content")).rejects.toMatchObject({
      code: "helper-unavailable",
      message: expect.stringContaining("EINVAL"),
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["never", "auto", "always"] as const)("respects clone=%s when no-replace publication is unavailable", async clone => {
    const directory = await tempRoot("fs-safe-noreplace-copy-");
    const source = path.join(directory, "source");
    await fs.writeFile(source, "source bytes");
    const copy = vi.fn<NonNullable<NonNullable<typeof native>["copyFileExclusive"]>>((fd, parent, name, _clone, maxBytes, signal) => {
      // Reach publication even on hosts without reflinks. Clone-policy routing,
      // rather than the platform clone primitive, is under test here.
      return native!.copyFileExclusive!(fd, parent, name, "never", maxBytes, signal);
    });
    __setNativeLoaderForTest(() => ({ ...native!, copyFileExclusive: copy, renameNoReplace() {
      throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
    } }));
    const scoped = await root(directory);
    const operation = scoped.copyIn("target", source, { clone, overwrite: false });
    if (clone === "always") {
      await expect(operation).rejects.toMatchObject({ code: "helper-unavailable" });
      expect(await fs.readdir(directory)).toEqual(["source"]);
    } else {
      await operation;
      expect(await scoped.readText("target")).toBe("source bytes");
      // The device cache must still honor an explicit cloning requirement.
      await expect(scoped.copyIn("required-clone", source, { clone: "always", overwrite: false }))
        .rejects.toMatchObject({ code: "helper-unavailable" });
      expect((await fs.readdir(directory)).sort()).toEqual(["source", "target"]);
    }
    expect(copy).toHaveBeenCalledOnce();
    expect(await scoped.readText("source")).toBe("source bytes");
  });

  it("retains native publication on a supporting filesystem", async () => {
    const directory = await tempRoot("fs-safe-noreplace-normal-");
    const rename = vi.fn(native!.renameNoReplace);
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename }));
    await (await root(directory)).create("target", "native");
    expect(rename).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });

  it("does not cache a cross-parent move's directory-ancestry EINVAL after a source swap", async () => {
    const directory = await tempRoot("fs-safe-noreplace-move-race-");
    const source = path.join(directory, "source");
    const saved = path.join(directory, "saved");
    const destination = path.join(directory, "destination");
    const nested = path.join(source, "nested");
    await fs.writeFile(source, "source");
    await fs.mkdir(destination);
    const rename = vi.fn<NonNullable<typeof native>["renameNoReplace"]>((...args) => {
      if (args[1] !== "source") return native!.renameNoReplace(...args);
      // Model a namespace swap in the final check-to-syscall gap: the held
      // destination parent becomes a descendant of the substituted source.
      fsSync.renameSync(source, saved);
      fsSync.mkdirSync(source);
      fsSync.renameSync(destination, nested);
      try { native!.renameNoReplace(...args); } finally {
        fsSync.renameSync(nested, destination);
        fsSync.rmdirSync(source);
        fsSync.renameSync(saved, source);
      }
    });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename }));
    const scoped = await root(directory);
    if (process.platform === "linux") await scoped.move("source", "destination/target");
    else await expect(scoped.move("source", "destination/target")).rejects.toMatchObject({ code: "helper-unavailable" });
    configureFsSafeNative({ mode: "require" });
    await scoped.create("target", "native still available");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await scoped.readText("target")).toBe("native still available");
    expect(await scoped.readText(process.platform === "linux" ? "destination/target" : "source")).toBe("source");
    expect(await fs.readdir(destination)).toEqual(process.platform === "linux" ? ["target"] : []);
  });

  it.skipIf(process.platform !== "linux" || !fsSync.existsSync("/dev/shm"))("keeps tmpfs native after another device rejects no-replace", async () => {
    const directory = await tempRoot("fs-safe-noreplace-device-");
    const tmpfs = await fs.mkdtemp("/dev/shm/fs-safe-noreplace-");
    try {
      const device = (await fs.stat(directory, { bigint: true })).dev;
      if (device === (await fs.stat(tmpfs, { bigint: true })).dev) return;
      const rename = vi.fn<NonNullable<typeof native>["renameNoReplace"]>((...args) => {
        if (fsSync.fstatSync(args[0], { bigint: true }).dev === device) {
          throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
        }
        native!.renameNoReplace(...args);
      });
      __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace: rename }));
      await (await root(directory)).create("fallback", "fallback");
      await (await root(tmpfs)).create("native", "native");
      expect(rename).toHaveBeenCalledTimes(2);
      expect(await fs.readdir(tmpfs)).toEqual(["native"]);
    } finally { await fs.rm(tmpfs, { recursive: true, force: true }); }
  });

  it("keeps a competing target created between rejection and fallback", async () => {
    const directory = await tempRoot("fs-safe-noreplace-competitor-");
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() {
      // The actual syscall rejected the flag; a competing writer wins next.
      fsSync.writeFileSync(path.join(directory, "target"), "competitor");
      throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
    } }));
    await expect((await root(directory)).create("target", "ours")).rejects.toMatchObject({ code: "already-exists" });
    expect(await fs.readFile(path.join(directory, "target"), "utf8")).toBe("competitor");
    expect(await fs.readdir(directory)).toEqual(["target"]);
  });

  it("does not retry after identity-checked cleanup fails and keeps publication primary", async () => {
    const directory = await tempRoot("fs-safe-noreplace-cleanup-");
    const remove = vi.fn(() => { throw Object.assign(new Error("unlink failed"), { code: "EIO" }); });
    __setNativeLoaderForTest(() => ({ ...native!, removeStagedFile: remove, renameNoReplace() {
      throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
    } }));
    await expect((await root(directory)).create("target", "ours")).rejects.toMatchObject({
      code: "helper-unavailable", message: expect.stringContaining("EINVAL"),
    });
    expect(remove).toHaveBeenCalledOnce();
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\.fs-safe-.*\.tmp$/);
  });

  it("keeps publication failure primary when an uncertain rename preserves its stage", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-noreplace-fallback-");
    const cause = Object.assign(new Error("rename without replacement: I/O error"), { code: "EIO" });
    __setNativeLoaderForTest(() => ({ ...native!, renameNoReplace() { throw cause; } }));
    await expect((await root(directory)).create("target", "content")).rejects.toMatchObject({
      code: "helper-failed", message: "staged file publish failed",
    });
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^\.fs-safe-.*\.tmp$/);
    expect(await fs.readFile(path.join(directory, names[0]!), "utf8")).toBe("content");
  });
});
