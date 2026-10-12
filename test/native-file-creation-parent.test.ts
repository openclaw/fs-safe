import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI provides the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest(); });

describe.runIf(native?.openCreateBeneath)("native missing-file parent admission", () => {
  it("rejects a parent replaced between its snapshot and native opening", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("native-file-parent-snapshot-");
    const parent = path.join(directory, "parent");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    let swapped = false;
    __setNativeLoaderForTest(() => ({ ...native!, openBeneath(...args) {
      if (!swapped && args[1] === "parent") {
        swapped = true;
        fs.renameSync(parent, path.join(directory, "held"));
        fs.mkdirSync(parent);
      }
      return native!.openBeneath!(...args);
    } }));
    await expect(safe.append("parent/file", "payload", { durable: false })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(fs.readdirSync(path.join(directory, "held"))).toEqual([]);
  });

  it("cleans its retained creation without writing through a replaced parent", async () => {
    configureFsSafeNative({ mode: "require" });
    const base = await tempRoot("native-file-parent-dispatch-");
    const directory = path.join(base, "root"), outside = path.join(base, "outside");
    const parent = path.join(directory, "parent"), held = path.join(directory, "held");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(outside);
    const safe = await root(directory);
    let createdFd: number | undefined;
    let closes = 0;
    __setNativeLoaderForTest(() => ({ ...native!,
      openCreateBeneath(...args) {
        fs.renameSync(parent, held);
        fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
        createdFd = native!.openCreateBeneath!(...args);
        return createdFd;
      },
      closeOwnedFd(fd) { if (fd === createdFd) closes++; return native!.closeOwnedFd!(fd); },
    }));
    await expect(safe.append("parent/file", "payload", { durable: false })).rejects.toThrow();
    expect(createdFd).toBeTypeOf("number");
    expect(closes).toBe(1);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(held)).toEqual([]);
  });

  it("retains a real authority callback on file creation", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("native-file-parent-callback-");
    fs.mkdirSync(path.join(directory, "parent"));
    const safe = await root(directory);
    let checked = false;
    await expect(safe.append("parent/file", "payload", {
      durable: false,
      assertBeforeMutation() { checked = true; throw new Error("authority denied"); },
    })).rejects.toThrow("authority denied");
    expect(checked).toBe(true);
    expect(fs.readdirSync(path.join(directory, "parent"))).toEqual([]);
  });

  it("validates a file that appears after the missing-path observation", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("native-file-create-collision-");
    const target = path.join(directory, "file");
    const safe = await root(directory);
    let inserted = false;
    __setNativeLoaderForTest(() => ({ ...native!, openCreateBeneath(...args) {
      if (!inserted) { inserted = true; fs.writeFileSync(target, "raced"); }
      return native!.openCreateBeneath!(...args);
    } }));
    await safe.append("file", "payload", { durable: false });
    expect(inserted).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("racedpayload");
  });

  it.each(["symlink", "hardlink"])("rejects a raced %s before appending outside data", async kind => {
    configureFsSafeNative({ mode: "require" });
    const base = await tempRoot("native-file-create-link-");
    const directory = path.join(base, "root");
    const outside = path.join(base, "outside");
    fs.mkdirSync(directory);
    fs.writeFileSync(outside, "outside");
    const safe = await root(directory);
    let inserted = false;
    __setNativeLoaderForTest(() => ({ ...native!, openCreateBeneath(...args) {
      if (!inserted) {
        inserted = true;
        if (kind === "symlink") fs.symlinkSync(outside, path.join(directory, "file"));
        else fs.linkSync(outside, path.join(directory, "file"));
      }
      return native!.openCreateBeneath!(...args);
    } }));
    await expect(safe.append("file", "payload", { durable: false })).rejects.toThrow();
    expect(inserted).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("keeps file contents and native parent cleanup ownership", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("native-file-parent-content-");
    fs.mkdirSync(path.join(directory, "parent"));
    const safe = await root(directory);
    await safe.append("parent/file", "payload", { durable: false });
    expect(fs.readFileSync(path.join(directory, "parent/file"), "utf8")).toBe("payload");
    const opened = await safe.openWritable("parent/other", { writeMode: "append" });
    await opened.handle.writeFile("second");
    await opened.handle.close();
    expect(fs.readFileSync(path.join(directory, "parent/other"), "utf8")).toBe("second");
  });
});
