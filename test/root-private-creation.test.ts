import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { hasPrivateCreationNative } from "./helpers/private-creation-native.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
// Native-off Windows cases execute several bounded system commands per creation.
const creationTimeout = process.platform === "win32" ? 120_000 : 10_000;
const nativeAvailable = hasPrivateCreationNative();
const nativeModes = process.platform === "darwin" ? ["auto", "require"] as const
  : nativeAvailable ? ["off", "auto", "require"] as const : ["off", "auto"] as const;

async function expectPrivate(target: string, directory: boolean): Promise<void> {
  if (process.platform === "win32") {
    const result = readOwnerAndDacl(target);
    expect(result).toMatchObject({ status: "supported", daclPresent: true, complete: true });
    if (result.status !== "supported") throw new Error("Windows ACL facts unavailable");
    expect(result.ownerSid).toBe(result.currentUserSid);
    const allowed = result.aces.filter((ace) => ace.aceType === "allow" && !ace.flags.inheritOnly);
    expect(allowed.map((ace) => ace.sid).toSorted()).toEqual(
      [result.currentUserSid, "s-1-5-18", "s-1-5-32-544"].toSorted(),
    );
  } else {
    expect((await fs.stat(target)).mode & 0o777).toBe(directory ? 0o700 : 0o600);
  }
}

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it("rejects unavailable required private writes before creating parents", async () => {
  const directory = await tempRoot("fs-safe-private-required-");
  const files = await root(directory);
  configureFsSafeNative({ mode: "require" });
  __setNativeLoaderForTest(() => { throw new Error("native addon unavailable"); });
  await expect(files.create("absent/value", "content", { private: true }))
    .rejects.toMatchObject({ code: "helper-unavailable" });
  expect(await fs.readdir(directory)).toEqual([]);
});

describe.skipIf(process.platform === "darwin" && !nativeAvailable).each(nativeModes)("Root private creation (%s)", (nativeMode) => {
  beforeEach(() => configureFsSafeNative({ mode: nativeMode }));

  it("creates private parents and accepts an unchanged private directory", async () => {
    const directory = await tempRoot("fs-safe-private-root-");
    const files = await root(directory);
    await Promise.all([
      files.mkdir("parent/child", { private: true }),
      files.mkdir("parent/child", { private: true }),
    ]);
    await expectPrivate(path.join(directory, "parent"), true);
    await expectPrivate(path.join(directory, "parent", "child"), true);
    const before = await fs.stat(path.join(directory, "parent", "child"), { bigint: true });
    await files.mkdir("parent/child", { private: true });
    const after = await fs.stat(path.join(directory, "parent", "child"), { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  }, creationTimeout);

  itPosix("rejects an existing public directory without changing its mode", async () => {
    const directory = await tempRoot("fs-safe-private-existing-");
    const target = path.join(directory, "public");
    await fs.mkdir(target);
    await fs.chmod(target, 0o755);
    const files = await root(directory);
    await expect(files.mkdir("public", { private: true })).rejects.toMatchObject({
      code: "insecure-permissions",
    });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    await files.mkdir("public", { private: false });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  }, creationTimeout);

  it("creates private buffered, atomic, JSON, and streamed files with complete contents", async () => {
    const directory = await tempRoot("fs-safe-private-content-");
    const files = await root(directory);
    const content = Buffer.alloc(512 * 1024 + 31, 0x71);
    await files.create("buffer/value", content, { private: true });
    await files.create("atomic/value", content, { private: true, atomic: true, durable: "file" });
    await files.createJson("json/value", { message: "private content" }, { private: true });
    await files.create("stream/value", (async function* () {
      yield content.subarray(0, 17);
      yield content.subarray(17);
    })(), { private: true });
    for (const child of ["buffer", "atomic", "stream"]) {
      expect((await fs.readFile(path.join(directory, child, "value"))).equals(content)).toBe(true);
    }
    expect(JSON.parse(await fs.readFile(path.join(directory, "json", "value"), "utf8")))
      .toEqual({ message: "private content" });
    for (const child of ["buffer", "atomic", "json", "stream"]) {
      await expectPrivate(path.join(directory, child), true);
      await expectPrivate(path.join(directory, child, "value"), false);
      expect(await fs.readdir(path.join(directory, child))).toEqual(["value"]);
    }
  }, creationTimeout);

  it("preserves existing file contents on exclusive private creation", async () => {
    const directory = await tempRoot("fs-safe-private-collision-");
    const files = await root(directory);
    await files.create("value", "original", { private: true });
    await expect(files.create("value", "replacement", { private: true }))
      .rejects.toMatchObject({ code: "already-exists" });
    expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("original");
    expect(await fs.readdir(directory)).toEqual(["value"]);
  }, creationTimeout);

  it("rejects conflicting permission options before creating parents", async () => {
    const directory = await tempRoot("fs-safe-private-mode-");
    const files = await root(directory);
    await expect(files.create("absent/value", "content", { private: true, mode: 0o644 }))
      .rejects.toMatchObject({ code: "insecure-permissions" });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("honors denied destinations and revoked mutation authority", async () => {
    const directory = await tempRoot("fs-safe-private-authority-");
    const denied = path.join(directory, "denied");
    const files = await root(directory, { denyMutations: { prefixes: [denied] } });
    await expect(files.mkdir("denied/child", { private: true }))
      .rejects.toMatchObject({ code: "denied-path" });
    const revoked = new Error("creation permission revoked");
    await expect(files.create("absent/value", "content", {
      private: true,
      assertBeforeMutation: () => { throw revoked; },
    })).rejects.toBe(revoked);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  itPosix("snapshots the private option before awaited directory admission", async () => {
    const directory = await tempRoot("fs-safe-private-snapshot-");
    const files = await root(directory);
    const options = { private: true };
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { options.private = false; } });
    await files.mkdir("parent/child", options);
    await expectPrivate(path.join(directory, "parent"), true);
    await expectPrivate(path.join(directory, "parent", "child"), true);
  });
});
