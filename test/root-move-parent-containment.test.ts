import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

it.skipIf(process.platform === "win32").each(
  (["source", "target"] as const).flatMap(boundary =>
    ([undefined, "follow-parents-within-root"] as const).map(policy => ({ boundary, policy }))),
)("rejects a $boundary parent moved outside Root after native open ($policy)", async ({ boundary, policy }) => {
  const base = await tempRoot("fs-safe-moved-native-parent-");
  const directory = path.join(base, "root");
  const outside = path.join(base, "outside");
  const allowed = path.join(directory, "allowed");
  const incoming = path.join(directory, "incoming");
  const moved = path.join(outside, "moved");
  await fs.mkdir(directory);
  await Promise.all([fs.mkdir(allowed), fs.mkdir(incoming), fs.mkdir(outside)]);
  await fs.writeFile(path.join(allowed, "source"), "opened source");
  await fs.writeFile(path.join(incoming, "source"), "incoming source");
  const directoryPaths = new Map<number, string>();
  let movedAfterOpen = false;
  let openedInside = false;
  let sameDescriptor = false;
  let renamed = false;
  const binding = {
    closeOwnedFd: fsSync.closeSync,
    openBeneath(_rootFd: number, relativePath: string, flags: number) {
      const canonical = fsSync.realpathSync(path.join(directory, relativePath));
      if (canonical !== directory && !canonical.startsWith(directory + path.sep)) {
        throw new Error("test native open escaped Root");
      }
      const fd = fsSync.openSync(canonical, flags);
      directoryPaths.set(fd, canonical);
      if (!movedAfterOpen && relativePath === "allowed") {
        // Opening was contained. The same descriptor remains pinned while
        // a peer moves its parent before TypeScript associates its pathname.
        openedInside = true;
        const before = fsSync.fstatSync(fd, { bigint: true });
        fsSync.renameSync(allowed, moved);
        fsSync.symlinkSync(moved, allowed, "dir");
        const after = fsSync.lstatSync(moved, { bigint: true });
        sameDescriptor = before.dev === after.dev && before.ino === after.ino;
        movedAfterOpen = true;
        directoryPaths.set(fd, moved);
      }
      return { fd, containment: "best-effort" as const };
    },
    renameNoReplace(sourceFd: number, sourceName: string, targetFd: number, targetName: string) {
      renamed = true;
      const source = path.join(directoryPaths.get(sourceFd)!, sourceName);
      const target = path.join(directoryPaths.get(targetFd)!, targetName);
      if (fsSync.existsSync(target)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      fsSync.renameSync(source, target);
    },
  } as unknown as NativeBinding;
  __setNativeLoaderForTest(() => binding);
  configureFsSafeNative({ mode: "require" });
  const scoped = await root(directory);

  await expect(scoped.move(
    boundary === "source" ? "allowed/source" : "incoming/source",
    boundary === "source" ? "published" : "allowed/published",
    { mutationSymlinks: policy },
  )).rejects.toMatchObject({ code: "outside-workspace" });

  expect({ movedAfterOpen, openedInside, sameDescriptor, renamed }).toEqual({
    movedAfterOpen: true, openedInside: true, sameDescriptor: true, renamed: false,
  });
  expect(await fs.readFile(path.join(moved, "source"), "utf8")).toBe("opened source");
  expect(await fs.readFile(path.join(incoming, "source"), "utf8")).toBe("incoming source");
  await expect(fs.lstat(path.join(moved, "published"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(path.join(directory, "published"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(process.platform === "win32").each(["root", "source", "target"] as const)(
  "rechecks the %s boundary after the mutation-authority callback", async boundary => {
    const base = await tempRoot("fs-safe-native-move-authority-boundary-");
    const directory = path.join(base, "root");
    const sourceParent = path.join(directory, "source");
    const targetParent = path.join(directory, "target");
    const moved = path.join(base, "moved");
    await fs.mkdir(directory);
    await Promise.all([fs.mkdir(sourceParent), fs.mkdir(targetParent)]);
    await fs.writeFile(path.join(sourceParent, "value"), "original");
    const directoryPaths = new Map<number, string>();
    let renamed = false;
    const binding = {
      closeOwnedFd: fsSync.closeSync,
      openBeneath(_rootFd: number, relativePath: string, flags: number) {
        const parent = path.join(directory, relativePath);
        const fd = fsSync.openSync(parent, flags);
        directoryPaths.set(fd, parent);
        return { fd, containment: "best-effort" as const };
      },
      renameNoReplace(sourceFd: number, sourceName: string, targetFd: number, targetName: string) {
        renamed = true;
        fsSync.renameSync(
          path.join(directoryPaths.get(sourceFd)!, sourceName),
          path.join(directoryPaths.get(targetFd)!, targetName),
        );
      },
    } as unknown as NativeBinding;
    __setNativeLoaderForTest(() => binding);
    configureFsSafeNative({ mode: "require" });
    const scoped = await root(directory);
    const changed = boundary === "root" ? directory : boundary === "source" ? sourceParent : targetParent;
    let callbackRan = false;

    await expect(scoped.move("source/value", "target/value", {
      assertBeforeMutation: () => {
        fsSync.renameSync(changed, moved);
        fsSync.mkdirSync(changed);
        // Retained native descriptors still address the moved original.
        for (const [fd, parent] of directoryPaths) {
          if (parent === changed || parent.startsWith(changed + path.sep)) {
            directoryPaths.set(fd, path.join(moved, path.relative(changed, parent)));
          }
        }
        callbackRan = true;
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(callbackRan).toBe(true);
    expect(renamed).toBe(false);
    const retainedSource = boundary === "root" ? path.join(moved, "source", "value")
      : boundary === "source" ? path.join(moved, "value") : path.join(sourceParent, "value");
    expect(await fs.readFile(retainedSource, "utf8")).toBe("original");
  },
);
