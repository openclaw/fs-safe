import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCanonicalPathWithinBase,
  resolveSafeInstallDir,
} from "../src/install-path.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { getNativeBinding, type NativeBinding } from "../src/native.js";
import { openPinnedFileSync } from "../src/pinned-open.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
} from "../src/regular-file.js";
import { replaceDirectoryAtomic } from "../src/replace-directory.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/replace-file.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret-file.js";
import { readSecureFile } from "../src/secure-file.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

let directoryReplacementNative: NativeBinding | undefined;
try {
  const native = getNativeBinding();
  if (typeof native?.renameNoReplaceWithIdentity === "function") {
    directoryReplacementNative = native;
  }
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

describe("owned caller pathname snapshots", () => {
  it("keeps asynchronous regular reads and appends on their first pathname", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-regular-async-");
    const readPath = path.join(root, "read.txt");
    const appendPath = path.join(root, "append.txt");
    const decoyPath = path.join(root, "decoy.txt");
    await fs.writeFile(readPath, "read-first");
    await fs.writeFile(appendPath, "append-first");
    await fs.writeFile(decoyPath, "decoy");

    let readPathCalls = 0;
    const read = await readRegularFile({
      get filePath() {
        readPathCalls += 1;
        return readPathCalls === 1 ? readPath : decoyPath;
      },
    });
    expect(read.buffer.toString()).toBe("read-first");
    expect(readPathCalls).toBe(1);

    let appendPathCalls = 0;
    await appendRegularFile({
      get filePath() {
        appendPathCalls += 1;
        return appendPathCalls === 1 ? appendPath : decoyPath;
      },
      content: ":updated",
    });
    expect(appendPathCalls).toBe(1);
    await expect(fs.readFile(appendPath, "utf8")).resolves.toBe("append-first:updated");
    await expect(fs.readFile(decoyPath, "utf8")).resolves.toBe("decoy");
  });

  it("keeps synchronous regular reads, appends, and pinned opens on the first path", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-regular-sync-");
    const readPath = path.join(root, "read.txt");
    const appendPath = path.join(root, "append.txt");
    const pinnedPath = path.join(root, "pinned.txt");
    const decoyPath = path.join(root, "decoy.txt");
    await fs.writeFile(readPath, "read-first");
    await fs.writeFile(appendPath, "append-first");
    await fs.writeFile(pinnedPath, "pinned-first");
    await fs.writeFile(decoyPath, "decoy");

    let readPathCalls = 0;
    const read = readRegularFileSync({
      get filePath() {
        readPathCalls += 1;
        return readPathCalls === 1 ? readPath : decoyPath;
      },
    });
    expect(read.buffer.toString()).toBe("read-first");
    expect(readPathCalls).toBe(1);

    let appendPathCalls = 0;
    appendRegularFileSync({
      get filePath() {
        appendPathCalls += 1;
        return appendPathCalls === 1 ? appendPath : decoyPath;
      },
      content: ":updated",
    });
    expect(appendPathCalls).toBe(1);
    expect(fsSync.readFileSync(appendPath, "utf8")).toBe("append-first:updated");

    let pinnedPathCalls = 0;
    const pinned = openPinnedFileSync({
      get filePath() {
        pinnedPathCalls += 1;
        return pinnedPathCalls === 1 ? pinnedPath : decoyPath;
      },
    });
    expect(pinnedPathCalls).toBe(1);
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) throw new Error("expected a pinned file");
    try {
      expect(fsSync.readFileSync(pinned.fd, "utf8")).toBe("pinned-first");
    } finally {
      fsSync.closeSync(pinned.fd);
    }
    expect(fsSync.readFileSync(decoyPath, "utf8")).toBe("decoy");
  });

  it("owns secure-file paths, trust containers, and trusted directory values", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-secure-");
    const outside = await tempRoot("fs-safe-path-snapshot-secure-outside-");
    const filePath = path.join(root, "secure.txt");
    const decoyPath = path.join(outside, "decoy.txt");
    await fs.writeFile(filePath, "secure-first");
    await fs.writeFile(decoyPath, "decoy");

    let filePathCalls = 0;
    let trustCalls = 0;
    let trustedDirsCalls = 0;
    const firstTrust = {
      get trustedDirs() {
        trustedDirsCalls += 1;
        return trustedDirsCalls === 1 ? [root] : [outside];
      },
    };
    const result = await readSecureFile({
      get filePath() {
        filePathCalls += 1;
        return filePathCalls === 1 ? filePath : decoyPath;
      },
      get trust() {
        trustCalls += 1;
        return trustCalls === 1 ? firstTrust : { trustedDirs: [outside] };
      },
      permissions: { allowInsecure: true },
    });

    expect(result.buffer.toString()).toBe("secure-first");
    expect(filePathCalls).toBe(1);
    expect(trustCalls).toBe(1);
    expect(trustedDirsCalls).toBe(1);
    await expect(fs.readFile(decoyPath, "utf8")).resolves.toBe("decoy");
  });

  it.each([
    ["write", writeSecretFileAtomic],
    ["create", createSecretFileAtomic],
  ] as const)("keeps %s secret publication on its first root and file", async (_kind, write) => {
    const root = await tempRoot("fs-safe-path-snapshot-secret-");
    const outside = await tempRoot("fs-safe-path-snapshot-secret-outside-");
    const filePath = path.join(root, "nested", "secret.txt");
    const decoyPath = path.join(outside, "decoy.txt");
    let rootCalls = 0;
    let filePathCalls = 0;

    await write({
      get rootDir() {
        rootCalls += 1;
        return rootCalls === 1 ? root : outside;
      },
      get filePath() {
        filePathCalls += 1;
        return filePathCalls === 1 ? filePath : decoyPath;
      },
      content: "secret-first",
    });

    expect(rootCalls).toBe(1);
    expect(filePathCalls).toBe(1);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("secret-first");
    await expect(fs.stat(decoyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps move source and destination endpoints on their first values", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-move-");
    const source = path.join(root, "source.txt");
    const target = path.join(root, "target.txt");
    const decoySource = path.join(root, "decoy-source.txt");
    const decoyTarget = path.join(root, "decoy-target.txt");
    await fs.writeFile(source, "source-first");
    await fs.writeFile(decoySource, "decoy");
    let fromCalls = 0;
    let toCalls = 0;
    let callbackGetterCalls = 0;
    let selectedSource = source;
    let selectedTarget = target;

    await movePathWithCopyFallback({
      get from() {
        fromCalls += 1;
        return selectedSource;
      },
      get to() {
        toCalls += 1;
        return selectedTarget;
      },
      get assertBeforeRename() {
        callbackGetterCalls += 1;
        selectedSource = decoySource;
        selectedTarget = decoyTarget;
        return undefined;
      },
    });

    expect(fromCalls).toBe(1);
    expect(toCalls).toBe(1);
    expect(callbackGetterCalls).toBe(1);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("source-first");
    await expect(fs.readFile(decoySource, "utf8")).resolves.toBe("decoy");
    await expect(fs.stat(decoyTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps directory replacement endpoints on their first values", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-replace-dir-");
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    const decoyStaged = path.join(root, "decoy-staged");
    const decoyTarget = path.join(root, "decoy-target");
    for (const directory of [staged, decoyStaged, decoyTarget]) {
      await fs.mkdir(directory);
    }
    await fs.writeFile(path.join(staged, "value.txt"), "staged-first");
    await fs.writeFile(path.join(decoyStaged, "value.txt"), "decoy-staged");
    await fs.writeFile(path.join(decoyTarget, "value.txt"), "decoy-target");
    let stagedCalls = 0;
    let targetCalls = 0;

    const replacement = replaceDirectoryAtomic({
      get stagedDir() {
        stagedCalls += 1;
        return stagedCalls === 1 ? staged : decoyStaged;
      },
      get targetDir() {
        targetCalls += 1;
        return targetCalls === 1 ? target : decoyTarget;
      },
    });

    if (directoryReplacementNative) {
      await expect(replacement).resolves.toBeUndefined();
    } else {
      await expect(replacement).rejects.toMatchObject({ code: "helper-unavailable" });
    }
    expect(stagedCalls).toBe(1);
    expect(targetCalls).toBe(1);
    if (directoryReplacementNative) {
      await expect(fs.readFile(path.join(target, "value.txt"), "utf8"))
        .resolves.toBe("staged-first");
      await expect(fs.stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(staged, "value.txt"), "utf8"))
        .resolves.toBe("staged-first");
    }
    await expect(fs.readFile(path.join(decoyStaged, "value.txt"), "utf8"))
      .resolves.toBe("decoy-staged");
    await expect(fs.readFile(path.join(decoyTarget, "value.txt"), "utf8"))
      .resolves.toBe("decoy-target");
  });

  it("passes the first async replace-file path through mode inheritance and publication", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-replace-file-async-");
    const target = path.join(root, "target.txt");
    const decoy = path.join(root, "decoy.txt");
    await fs.writeFile(target, "target-old");
    await fs.writeFile(decoy, "decoy");
    let filePathCalls = 0;

    await replaceFileAtomic({
      get filePath() {
        filePathCalls += 1;
        return filePathCalls === 1 ? target : decoy;
      },
      content: "target-new",
      preserveExistingMode: true,
    });

    expect(filePathCalls).toBe(1);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("target-new");
    await expect(fs.readFile(decoy, "utf8")).resolves.toBe("decoy");
  });

  it("passes the first sync replace-file path through mode inheritance and publication", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-replace-file-sync-");
    const target = path.join(root, "target.txt");
    const decoy = path.join(root, "decoy.txt");
    await fs.writeFile(target, "target-old");
    await fs.writeFile(decoy, "decoy");
    let filePathCalls = 0;

    replaceFileAtomicSync({
      get filePath() {
        filePathCalls += 1;
        return filePathCalls === 1 ? target : decoy;
      },
      content: "target-new",
      preserveExistingMode: true,
    });

    expect(filePathCalls).toBe(1);
    expect(fsSync.readFileSync(target, "utf8")).toBe("target-new");
    expect(fsSync.readFileSync(decoy, "utf8")).toBe("decoy");
  });

  it("captures install bases and canonical candidates before encoder or I/O access", async () => {
    const root = await tempRoot("fs-safe-path-snapshot-install-");
    const outside = await tempRoot("fs-safe-path-snapshot-install-outside-");
    const candidate = path.join(root, "candidate");
    await fs.mkdir(candidate);
    let resolveBaseCalls = 0;
    const resolved = resolveSafeInstallDir({
      get baseDir() {
        resolveBaseCalls += 1;
        return resolveBaseCalls === 1 ? root : outside;
      },
      id: "package",
      invalidNameMessage: "invalid package",
    });
    expect(resolveBaseCalls).toBe(1);
    expect(resolved).toEqual({ ok: true, path: path.join(root, "package") });

    let baseCalls = 0;
    let candidateCalls = 0;
    await expect(assertCanonicalPathWithinBase({
      get baseDir() {
        baseCalls += 1;
        return baseCalls === 1 ? root : outside;
      },
      get candidatePath() {
        candidateCalls += 1;
        return candidateCalls === 1 ? candidate : outside;
      },
      boundaryLabel: "install directory",
    })).resolves.toBeUndefined();
    expect(baseCalls).toBe(1);
    expect(candidateCalls).toBe(1);
  });
});
