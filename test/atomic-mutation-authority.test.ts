import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceFileAtomic,
  replaceFileAtomicSync,
  type ReplaceFileAtomicOptions,
} from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
type DestinationState = Parameters<NonNullable<ReplaceFileAtomicOptions["onDestinationState"]>>[0];
type Phase = "open" | "removed" | "truncate" | "write";
type Hooks = {
  fallback?: boolean;
  shortWrite?: boolean;
  after?: (phase: Phase) => void;
  beforeOpen?: () => void;
  afterRename?: () => void;
  afterStageOpen?: () => void;
  afterStageWrite?: () => void;
  afterMkdir?: () => void;
  afterDestinationStat?: () => void;
  beforeDestinationMutation?: () => void;
  closeError?: Error;
};

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function fixture(synchronous: boolean, hooks: Hooks = {}) {
  const directory = await tempRoot("fs-safe-atomic-authority-");
  const filePath = path.join(directory, "value");
  fs.writeFileSync(filePath, "original");
  const descriptors = new Set<number>();
  let renames = 0, destinationWrites = 0;
  let openedIdentity: fs.BigIntStats | undefined;
  const isDestinationOpen = (candidate: fs.PathLike, flags: fs.OpenMode) =>
    String(candidate) === filePath && typeof flags === "number" &&
    Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR));
  const opened = (fd: number) => {
    descriptors.add(fd);
    openedIdentity = fs.fstatSync(fd, { bigint: true });
    hooks.after?.("open");
  };
  const rename = (from: fs.PathLike, to: fs.PathLike) => {
    renames++;
    if (hooks.fallback) throw errno("EPERM");
    fs.renameSync(from, to);
    hooks.afterRename?.();
  };
  const removed = (candidate: fs.PathLike) => {
    if (String(candidate) === filePath) hooks.after?.("removed");
  };
  const write = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
    const tracked = descriptors.has(fd);
    if (tracked) hooks.beforeDestinationMutation?.();
    const count = fs.writeSync(fd, buffer, offset, tracked && hooks.shortWrite ? Math.min(2, length) : length, position);
    if (tracked) { destinationWrites++; hooks.after?.("write"); }
    return count;
  };
  const sync = {
    ...fs,
    renameSync: rename,
    rmSync: ((candidate, options) => { fs.rmSync(candidate, options); removed(candidate); }) as typeof fs.rmSync,
    openSync: ((candidate, flags, mode) => {
      const tracked = isDestinationOpen(candidate, flags);
      if (tracked) hooks.beforeOpen?.();
      const fd = fs.openSync(candidate, flags, mode);
      if (tracked) opened(fd);
      if (flags === "wx") hooks.afterStageOpen?.();
      return fd;
    }) as typeof fs.openSync,
    writeFileSync: ((...args) => {
      fs.writeFileSync(...args);
      hooks.afterStageWrite?.();
    }) as typeof fs.writeFileSync,
    writeSync: write as typeof fs.writeSync,
    ftruncateSync(fd: number, length?: number) {
      if (descriptors.has(fd)) hooks.beforeDestinationMutation?.();
      fs.ftruncateSync(fd, length);
      if (descriptors.has(fd)) hooks.after?.("truncate");
    },
    closeSync(fd: number) {
      const tracked = descriptors.delete(fd);
      fs.closeSync(fd);
      if (tracked && hooks.closeError) throw hooks.closeError;
    },
  };
  const async = {
    ...fsp,
    mkdir: (async (...args) => { const result = await fsp.mkdir(...args); hooks.afterMkdir?.(); return result; }) as typeof fsp.mkdir,
    rename: async (from: fs.PathLike, to: fs.PathLike) => { rename(from, to); },
    lstat: (async (...args) => {
      const stat = await fsp.lstat(...args);
      if (String(args[0]) === filePath) hooks.afterDestinationStat?.();
      return stat;
    }) as typeof fsp.lstat,
    writeFile: (async (...args) => {
      await fsp.writeFile(...args);
      hooks.afterStageWrite?.();
    }) as typeof fsp.writeFile,
    rm: (async (candidate, options) => { await fsp.rm(candidate, options); removed(candidate); }) as typeof fsp.rm,
    open: (async (candidate, flags, mode) => {
      const tracked = isDestinationOpen(candidate, flags);
      if (tracked) hooks.beforeOpen?.();
      const handle = await fsp.open(candidate, flags, mode);
      if (flags === "wx") hooks.afterStageOpen?.();
      if (!tracked) return handle;
      opened(handle.fd);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "write") return async (buffer: Uint8Array, offset: number, length: number, position: number | null) =>
            ({ bytesWritten: write(target.fd, buffer, offset, length, position), buffer });
          if (key === "truncate") return async (length?: number) => {
            hooks.beforeDestinationMutation?.();
            await target.truncate(length);
            hooks.after?.("truncate");
          };
          if (key === "writeFile") return async (data: Uint8Array) => {
            hooks.beforeDestinationMutation?.();
            await target.writeFile(data);
            destinationWrites++;
            hooks.after?.("write");
          };
          if (key === "close") return async () => {
            descriptors.delete(target.fd);
            await target.close();
            if (hooks.closeError) throw hooks.closeError;
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    }) as typeof fsp.open,
  };
  const run = async (options: Omit<ReplaceFileAtomicOptions, "filePath" | "content" | "fileSystem"> = {}) => {
    const common = { filePath, content: "replacement", ...options };
    return synchronous
      ? replaceFileAtomicSync({ ...common, fileSystem: sync })
      : await replaceFileAtomic({ ...common, fileSystem: { promises: async } });
  };
  return {
    directory, filePath, run,
    counts: () => ({ renames, destinationWrites, openDescriptors: descriptors.size }),
    openedIdentity: () => openedIdentity,
  };
}

for (const synchronous of [false, true]) {
  describe(`atomic mutation authority (sync=${synchronous})`, () => {
    it.each(["rename", "create", "restore"] as const)("reports successful %s transitions", async route => {
      const item = await fixture(synchronous, { fallback: route !== "rename" });
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: route === "restore" ? "restore-original" : "none",
        maxRestoreBytes: 64,
        onDestinationState: receipt => {
          receipts.push(receipt);
          if (receipt.state === "removed") expect(fs.existsSync(item.filePath)).toBe(false);
          else {
            const opened = fs.statSync(item.filePath, { bigint: true });
            expect(receipt).toEqual({ state: receipt.state, path: item.filePath, dev: opened.dev, ino: opened.ino });
            expect(fs.readFileSync(item.filePath, "utf8"))
              .toBe(receipt.state === "published" ? "replacement" : "");
          }
          expect(Object.isFrozen(receipt)).toBe(true);
        },
      })).resolves.toEqual({ method: route === "rename" ? "rename" : "copy-fallback" });
      expect(receipts.map(receipt => receipt.state)).toEqual(
        route === "rename" ? ["published"] : route === "restore" ? ["writing", "published"] : ["removed", "writing", "published"],
      );
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    it("captures callbacks before caller code can replace them", async () => {
      const directory = await tempRoot("fs-safe-atomic-callback-capture-");
      const receipts: DestinationState[] = [];
      const common = {
        filePath: path.join(directory, "value"), content: "replacement",
        assertBeforeMutation: () => {},
        onDestinationState: (receipt: DestinationState) => { receipts.push(receipt); },
      };
      const replaceCallbacks = (options: typeof common) => {
        options.assertBeforeMutation = () => { throw new Error("substituted authority"); };
        options.onDestinationState = () => { throw new Error("substituted observer"); };
      };
      if (synchronous) {
        const options = { ...common, beforeRename: () => { replaceCallbacks(options); } };
        replaceFileAtomicSync(options);
      } else {
        const options = { ...common };
        const pending = replaceFileAtomic(options);
        replaceCallbacks(options);
        await pending;
      }
      expect(receipts.map(receipt => receipt.state)).toEqual(["published"]);
      expect(fs.readFileSync(common.filePath, "utf8")).toBe("replacement");
    });

    it("refuses before creating the destination directory", async () => {
      const directory = await tempRoot("fs-safe-atomic-initial-refusal-");
      const filePath = path.join(directory, "missing", "value");
      const refusal = new Error("lease revoked");
      const options = { filePath, content: "replacement", assertBeforeMutation: () => { throw refusal; } };
      const run = async () => synchronous ? replaceFileAtomicSync(options) : await replaceFileAtomic(options);
      await expect(run()).rejects.toBe(refusal);
      expect(fs.readdirSync(directory)).toEqual([]);
    });

    it.each(["open", "write"])("cleans its private stage after revocation at stage %s", async phase => {
      let live = true, stageWrites = 0;
      const item = await fixture(synchronous, {
        afterStageOpen: () => { if (phase === "open") live = false; },
        afterStageWrite: () => { stageWrites++; if (phase === "write") live = false; },
      });
      const refusal = new Error("lease revoked");
      await expect(item.run({ assertBeforeMutation: () => { if (!live) throw refusal; } }))
        .rejects.toBe(refusal);
      expect(stageWrites).toBe(phase === "write" ? 1 : 0);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("original");
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
      expect(item.counts()).toEqual({ renames: 0, destinationWrites: 0, openDescriptors: 0 });
    });

    it.each(["EPERM", "EBUSY"])("does not reinterpret a %s refusal as a rename failure", async code => {
      const item = await fixture(synchronous);
      const refusal = errno(code);
      let live = true, refusals = 0;
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        renameMaxRetries: 1,
        renameRetryBaseDelayMs: 0,
        beforeRename: async () => { live = false; },
        assertBeforeMutation: () => { if (!live) { refusals++; throw refusal; } },
      })).rejects.toBe(refusal);
      expect(refusals).toBe(1);
      expect(item.counts()).toEqual({ renames: 0, destinationWrites: 0, openDescriptors: 0 });
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("original");
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    it.each([
      { phase: "removed", restore: "none", remaining: null, states: ["removed"] },
      { phase: "open", restore: "none", remaining: "", states: ["removed", "writing"] },
      { phase: "truncate", restore: "restore-original", remaining: "", states: ["writing"] },
      { phase: "write", restore: "restore-original", remaining: "re", states: ["writing"] },
      { phase: "write", restore: "none", remaining: "re", states: ["removed", "writing"] },
    ] as const)("stops after $phase with restoration=$restore", async ({ phase, restore, remaining, states }) => {
      let live = true;
      const item = await fixture(synchronous, {
        fallback: true, shortWrite: true,
        after: observed => { if (observed === phase) live = false; },
      });
      const refusal = new Error("lease revoked");
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: restore,
        maxRestoreBytes: 64,
        assertBeforeMutation: () => { if (!live) throw refusal; },
        onDestinationState: receipt => { receipts.push(receipt); },
      })).rejects.toBe(refusal);
      expect(receipts.map(receipt => receipt.state)).toEqual(states);
      for (const receipt of receipts) {
        expect(receipt.path).toBe(item.filePath);
        expect(Object.isFrozen(receipt)).toBe(true);
        if (receipt.state !== "removed") {
          expect(receipt).toMatchObject({ dev: item.openedIdentity()!.dev, ino: item.openedIdentity()!.ino });
          expect(typeof receipt.ino).toBe("bigint");
        }
      }
      expect(item.counts()).toEqual({ renames: 1, destinationWrites: phase === "write" ? 1 : 0, openDescriptors: 0 });
      expect(remaining === null ? fs.existsSync(item.filePath) : fs.readFileSync(item.filePath, "utf8"))
        .toBe(remaining === null ? false : remaining);
      expect(fs.readdirSync(item.directory)).toEqual(remaining === null ? [] : ["value"]);
    });

    it("retains the opened identity and preserves a replacement after observer revocation", async () => {
      const item = await fixture(synchronous, { fallback: true });
      const movedPath = path.join(item.directory, "owned");
      const refusal = errno("EPERM");
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 64,
        onDestinationState: receipt => {
          receipts.push(receipt);
          if (receipt.state !== "writing") return;
          fs.renameSync(item.filePath, movedPath);
          fs.writeFileSync(item.filePath, "competitor");
          throw refusal;
        },
      })).rejects.toBe(refusal);
      expect(receipts).toEqual([expect.objectContaining({
        state: "writing", path: item.filePath,
        dev: fs.statSync(movedPath, { bigint: true }).dev,
        ino: fs.statSync(movedPath, { bigint: true }).ino,
      })]);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("competitor");
      expect(fs.readFileSync(movedPath, "utf8")).toBe("");
      expect(item.counts()).toEqual({ renames: 1, destinationWrites: 0, openDescriptors: 0 });
      expect(fs.readdirSync(item.directory).sort()).toEqual(["owned", "value"]);
    });

    it("preserves a genuine exclusive-create collision without inventing a writing receipt", async () => {
      const hooks: Hooks = { fallback: true };
      const item = await fixture(synchronous, hooks);
      hooks.beforeOpen = () => { fs.writeFileSync(item.filePath, "competitor", { flag: "wx" }); };
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        onDestinationState: receipt => { receipts.push(receipt); },
      })).rejects.toMatchObject({ code: "EEXIST" });
      expect(receipts).toEqual([{ state: "removed", path: item.filePath }]);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("competitor");
      expect(item.counts()).toEqual({ renames: 1, destinationWrites: 0, openDescriptors: 0 });
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    it("retains a verified publication receipt after a later destination replacement", async () => {
      const item = await fixture(synchronous);
      const movedPath = path.join(item.directory, "published");
      const receipts: DestinationState[] = [];
      await expect(item.run({ syncParentDir: true, onDestinationState: receipt => {
        receipts.push(receipt);
        fs.renameSync(item.filePath, movedPath);
        fs.writeFileSync(item.filePath, "competitor");
      } })).rejects.toMatchObject({ code: "path-mismatch" });
      const published = fs.statSync(movedPath, { bigint: true });
      expect(receipts).toEqual([{ state: "published", path: item.filePath, dev: published.dev, ino: published.ino }]);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("competitor");
      expect(fs.readFileSync(movedPath, "utf8")).toBe("replacement");
      expect(fs.readdirSync(item.directory).sort()).toEqual(["published", "value"]);
    });

    it("keeps the caller hash guard active after opening an existing restore target", async () => {
      const hooks: Hooks = { fallback: true };
      const item = await fixture(synchronous, hooks);
      const inode = fs.statSync(item.filePath, { bigint: true }).ino;
      const hash = () => createHash("sha256").update(fs.readFileSync(item.filePath)).digest("hex");
      const originalHash = hash(), refusal = new Error("external edit"), receipts: DestinationState[] = [];
      let mutations = 0;
      hooks.after = phase => { if (phase === "open") fs.writeFileSync(item.filePath, "external", { flag: "r+" }); };
      hooks.beforeDestinationMutation = () => { mutations++; };
      const failure = await item.run({
        copyFallbackOnPermissionError: true, copyFallbackRestore: "restore-original", maxRestoreBytes: 64,
        onDestinationState: receipt => { receipts.push(receipt); },
        assertBeforeMutation: () => { if (!receipts.some(receipt => receipt.state === "writing") && hash() !== originalHash) throw refusal; },
      }).then(() => undefined, error => error);
      expect({ failure, mutations, receipts, bytes: fs.readFileSync(item.filePath, "utf8"), inode: fs.statSync(item.filePath, { bigint: true }).ino })
        .toEqual({ failure: refusal, mutations: 0, receipts: [], bytes: "external", inode });
    });

    it.each(["authority", "rename"])("does not claim publication after substitution during %s", async timing => {
      const hooks: Hooks = {};
      const item = await fixture(synchronous, hooks);
      const movedPath = path.join(item.directory, "owned");
      let stage = "";
      const substitute = (source: string) => {
        fs.renameSync(source, movedPath);
        fs.writeFileSync(source, "substitute");
      };
      if (timing === "rename") hooks.afterRename = () => { substitute(item.filePath); };
      const receipts: DestinationState[] = [];
      await expect(item.run({
        beforeRename: async ({ tempPath }) => { stage = tempPath; },
        assertBeforeMutation: () => { if (timing === "authority" && stage) { const current = stage; stage = ""; substitute(current); } },
        onDestinationState: receipt => { receipts.push(receipt); },
      })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(receipts).toEqual([]);
      expect(fs.readFileSync(movedPath, "utf8")).toBe("replacement");
    });

    it.each(["EPERM", "EBUSY"])("does not undo or retry publication when the observer throws %s", async code => {
      const item = await fixture(synchronous);
      const refusal = errno(code);
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        renameMaxRetries: 1,
        renameRetryBaseDelayMs: 0,
        onDestinationState: receipt => { receipts.push(receipt); throw refusal; },
      })).rejects.toBe(refusal);
      expect(receipts.map(receipt => receipt.state)).toEqual(["published"]);
      expect(item.counts()).toEqual({ renames: 1, destinationWrites: 0, openDescriptors: 0 });
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("replacement");
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    it("preserves the observer refusal when fallback close also fails", async () => {
      const item = await fixture(synchronous, { fallback: true, closeError: errno("EIO") });
      const refusal = new Error("observer refused");
      const receipts: DestinationState[] = [];
      await expect(item.run({
        copyFallbackOnPermissionError: true,
        onDestinationState: receipt => {
          receipts.push(receipt);
          if (receipt.state === "published") throw refusal;
        },
      })).rejects.toBe(refusal);
      expect(receipts.map(receipt => receipt.state)).toEqual(["removed", "writing", "published"]);
      expect(item.counts().openDescriptors).toBe(0);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("replacement");
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    it("preserves the first authority refusal during restoration", async () => {
      let live = true;
      const refusal = new Error("restoration refused");
      const item = await fixture(synchronous, {
        fallback: true, shortWrite: true,
        after: phase => { if (phase === "write") { live = false; throw errno("EIO"); } },
      });
      await expect(item.run({
        copyFallbackOnPermissionError: true, copyFallbackRestore: "restore-original", maxRestoreBytes: 64,
        assertBeforeMutation: () => { if (!live) throw refusal; },
      })).rejects.toBe(refusal);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("re");
      expect(item.counts()).toEqual({ renames: 1, destinationWrites: 1, openDescriptors: 0 });
      expect(fs.readdirSync(item.directory)).toEqual(["value"]);
    });

    for (const callback of ["assertBeforeMutation", "onDestinationState"] as const) {
      it(`rejects ${callback} returning a promise`, async () => {
        const item = await fixture(synchronous);
        await expect(item.run({ [callback]: () => Promise.reject(new Error("async refusal")) }))
          .rejects.toBeInstanceOf(TypeError);
        expect(fs.readFileSync(item.filePath, "utf8"))
          .toBe(callback === "onDestinationState" ? "replacement" : "original");
        expect(fs.readdirSync(item.directory)).toEqual(["value"]);
      });
    }

    it("ignores ordinary synchronous callback results", async () => {
      const item = await fixture(synchronous);
      const receipts: DestinationState[] = [];
      await expect(item.run({
        assertBeforeMutation: () => false,
        onDestinationState: receipt => receipts.push(receipt),
      })).resolves.toEqual({ method: "rename" });
      expect(receipts.map(receipt => receipt.state)).toEqual(["published"]);
      expect(fs.readFileSync(item.filePath, "utf8")).toBe("replacement");
    });
  });
}

it("rechecks async authority at dispatch after awaited destination verification", async () => {
  let live = true, writing = false, destinationObserved = false, revokedDispatches = 0;
  const item = await fixture(false, {
    fallback: true,
    afterDestinationStat: () => { destinationObserved = true; },
    beforeDestinationMutation: () => { if (!live) revokedDispatches++; },
  });
  const refusal = new Error("lease revoked in a microtask");
  await expect(item.run({
    copyFallbackOnPermissionError: true,
    onDestinationState: receipt => {
      if (receipt.state === "writing") { writing = true; destinationObserved = false; }
    },
    assertBeforeMutation: () => {
      if (!live) throw refusal;
      if (writing && destinationObserved) {
        destinationObserved = false;
        queueMicrotask(() => { live = false; });
      }
    },
  })).rejects.toBe(refusal);
  expect(live).toBe(false);
  expect(revokedDispatches).toBe(0);
  expect(item.counts().openDescriptors).toBe(0);
  expect(fs.readdirSync(item.directory)).toEqual(["value"]);
});

it("rejects authority revoked during mkdir before acquiring a rename identity lock", async () => {
  let live = true, sawSidecar = false;
  const item = await fixture(false, { afterMkdir: () => { live = false; } });
  const refusal = new Error("revoked while making parent");
  await expect(item.run({
    renameIdentity: "verify-content-with-lock",
    assertBeforeMutation: () => {
      if (!live) {
        sawSidecar ||= fs.readdirSync(item.directory).some(name => name.endsWith(".lock"));
        throw refusal;
      }
    },
  })).rejects.toBe(refusal);
  expect(sawSidecar).toBe(false);
  expect(fs.readFileSync(item.filePath, "utf8")).toBe("original");
  expect(fs.readdirSync(item.directory)).toEqual(["value"]);
});
