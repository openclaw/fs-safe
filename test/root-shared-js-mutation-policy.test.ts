import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DenyMutationPolicy } from "../src/deny-mutations.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import type { MutationSymlinkPolicy } from "../src/root-symlink-policy.js";
import * as existingPath from "../src/root-path-existing.js";
import { root, type Root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

type PolicyOptions = {
  denyMutations?: DenyMutationPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
  assertBeforeMutation?: () => void;
};

type Operation = Readonly<{
  name: string;
  kind: "directory" | "file";
  run(safe: Root, relativePath: string, options: PolicyOptions): Promise<void>;
}>;

const openOperation = (writeMode: "append" | "replace" | "update"): Operation => ({
  name: `openWritable-${writeMode}`,
  kind: "file",
  async run(safe, relativePath, options) {
    const opened = await safe.openWritable(relativePath, { ...options, writeMode });
    await opened.handle.close();
  },
});

const followedFinalLinkOperations: readonly Operation[] = [
  openOperation("replace"),
  openOperation("append"),
  openOperation("update"),
  {
    name: "append",
    kind: "file",
    async run(safe, relativePath, options) {
      await safe.append(relativePath, Buffer.from("payload"), { ...options, durable: false });
    },
  },
];

const sharedOperations: readonly Operation[] = [
  ...followedFinalLinkOperations,
  {
    name: "mkdir",
    kind: "directory",
    async run(safe, relativePath, options) {
      await safe.mkdir(relativePath, options);
    },
  },
  ...(process.platform === "win32" ? [
    {
      name: "write-buffer-overwrite",
      kind: "file" as const,
      async run(safe: Root, relativePath: string, options: PolicyOptions) {
        await safe.write(relativePath, Buffer.from("payload"), {
          ...options, durable: false, overwrite: true,
        });
      },
    },
    {
      name: "write-buffer-exclusive",
      kind: "file" as const,
      async run(safe: Root, relativePath: string, options: PolicyOptions) {
        await safe.write(relativePath, Buffer.from("payload"), {
          ...options, durable: false, overwrite: false,
        });
      },
    },
    {
      name: "create-buffer",
      kind: "file" as const,
      async run(safe: Root, relativePath: string, options: PolicyOptions) {
        await safe.create(relativePath, Buffer.from("payload"), { ...options, durable: false });
      },
    },
  ] : []),
];

function captureOpenedHandles(): FileHandle[] {
  const handles: FileHandle[] = [];
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    handles.push(handle);
    return handle;
  });
  return handles;
}

describe("shared JavaScript mutation-policy component admission", () => {
  it.each(sharedOperations.flatMap((operation) => [
    { operation, deniedDepth: "first" as const },
    { operation, deniedDepth: "deeper" as const },
  ]))("denies a $deniedDepth missing component before $operation.name creates it", async ({
    operation,
    deniedDepth,
  }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-missing-");
    const denied = path.join(directory, "one", ...(deniedDepth === "first" ? [] : ["two"]));
    const safe = await root(directory);

    await expect(operation.run(safe, "one/two/value", {
      denyMutations: { paths: [denied] },
    })).rejects.toMatchObject({ code: "denied-path" });

    if (deniedDepth === "first") {
      await expect(fs.lstat(path.join(directory, "one"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readdir(path.join(directory, "one"))).toEqual([]);
      await expect(fs.lstat(denied)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(sharedOperations)("allows $name below an exact existing denied parent", async (operation) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-existing-");
    const existing = path.join(directory, "existing");
    await fs.mkdir(existing);
    const safe = await root(directory);

    await operation.run(safe, "existing/value", {
      denyMutations: { paths: [existing] },
    });

    expect((await fs.lstat(path.join(existing, "value"))).isDirectory()).toBe(
      operation.kind === "directory",
    );
  });

  it.each(sharedOperations)("blocks $name below a denied prefix", async (operation) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-prefix-");
    const denied = path.join(directory, "denied");
    await fs.mkdir(denied);
    const safe = await root(directory);

    await expect(operation.run(safe, "denied/value", {
      denyMutations: { prefixes: [denied] },
    })).rejects.toMatchObject({ code: "denied-path" });
    expect(await fs.readdir(denied)).toEqual([]);
  });

  it("does not treat an exact denied future descendant as a protected ancestor", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-future-");
    const safe = await root(directory);
    await safe.mkdir("parent", {
      denyMutations: { paths: [path.join(directory, "parent", "future")] },
    });
    expect((await fs.stat(path.join(directory, "parent"))).isDirectory()).toBe(true);
  });

  it("keeps default and per-call policies additive on a shared write route", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-additive-");
    const defaultDenied = path.join(directory, "default", "value");
    const callDenied = path.join(directory, "call", "value");
    const safe = await root(directory, { denyMutations: { paths: [defaultDenied] } });

    await expect(safe.openWritable("default/value", {
      denyMutations: { paths: [] },
    })).rejects.toMatchObject({ code: "denied-path" });
    await expect(safe.openWritable("call/value", {
      denyMutations: { paths: [callDenied] },
    })).rejects.toMatchObject({ code: "denied-path" });
  });

  it("snapshots caller-owned policy arrays before the first observation", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-snapshot-");
    const denied = path.join(directory, "one");
    const deniedPaths = [denied];
    let mutated = false;
    const safe = await root(directory);
    const lstat = fsSync.lstatSync.bind(fsSync);
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      if (!mutated) {
        mutated = true;
        deniedPaths.length = 0;
      }
      return lstat(...args);
    }) as typeof fsSync.lstatSync);

    await expect(safe.openWritable("one/two/value", {
      denyMutations: { paths: deniedPaths },
    })).rejects.toMatchObject({ code: "denied-path" });
    expect(mutated).toBe(true);
    await expect(fs.lstat(denied)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-resolves a parent replaced after preflight before granting admission", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-redirect-");
    const allowed = path.join(directory, "allowed");
    const saved = path.join(directory, "saved");
    const denied = path.join(directory, "denied");
    await fs.mkdir(allowed);
    await fs.mkdir(denied);
    let redirected = false;
    __setFsSafeTestHooksForTest({
      async beforePinnedWriteParentAdmission() {
        if (redirected) return;
        redirected = true;
        await fs.rename(allowed, saved);
        await fs.symlink(denied, allowed, process.platform === "win32" ? "junction" : "dir");
      },
    });
    const safe = await root(directory);

    await expect(safe.openWritable("allowed/value", {
      denyMutations: { prefixes: [denied] },
    })).rejects.toMatchObject({ code: "denied-path" });
    expect(redirected).toBe(true);
    expect(await fs.readdir(denied)).toEqual([]);
    expect(await fs.readdir(saved)).toEqual([]);
  });

  it("honors authority revocation after exactly one parent mkdir", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-revoke-");
    const revoked = new Error("revoked");
    let checks = 0;
    const safe = await root(directory);

    await expect(safe.openWritable("one/two/value", {
      mutationSymlinks: "reject",
      assertBeforeMutation() {
        checks += 1;
        if (checks === 2) throw revoked;
      },
    })).rejects.toBe(revoked);
    expect(checks).toBe(2);
    expect(await fs.readdir(path.join(directory, "one"))).toEqual([]);
  });

  it("fences the exact parent after the authority callback", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-parent-swap-");
    const parent = path.join(directory, "one");
    const saved = path.join(directory, "saved");
    await fs.mkdir(parent);
    let swapped = false;
    const safe = await root(directory);

    await expect(safe.openWritable("one/two/value", {
      mutationSymlinks: "reject",
      assertBeforeMutation() {
        if (swapped) return;
        swapped = true;
        fsSync.renameSync(parent, saved);
        fsSync.mkdirSync(parent);
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readdir(saved)).toEqual([]);
  });

  it("preserves contained parent aliases unless explicit rejection is requested", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-alias-");
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await fs.mkdir(path.join(actual, "nested"), { recursive: true });
    await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const safe = await root(directory);

    const opened = await safe.openWritable("alias/nested/value", {
      mkdir: false,
      denyMutations: { paths: [path.join(directory, "unrelated")] },
    });
    await opened.handle.close();
    expect((await fs.lstat(path.join(actual, "nested/value"))).isFile()).toBe(true);
    await expect(safe.openWritable("alias/rejected/value", {
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "symlink" });
    await expect(fs.lstat(path.join(actual, "rejected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy final-symlink following when only deny policy is configured", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-final-link-");
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await fs.writeFile(actual, "unchanged");
    await fs.symlink(actual, alias, "file");
    const safe = await root(directory);

    const opened = await safe.openWritable("alias", {
      writeMode: "update",
      denyMutations: { paths: [path.join(directory, "unrelated")] },
    });
    expect(opened.realPath).toBe(await fs.realpath(actual));
    await opened.handle.close();
    expect(await fs.readFile(actual, "utf8")).toBe("unchanged");
    await expect(safe.openWritable("alias", {
      writeMode: "update",
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "symlink" });
  });

  it.each(followedFinalLinkOperations)(
    "applies $name policy admission to the selected final-link destination",
    async (operation) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-selected-");
      const selected = path.join(directory, "selected");
      const initiallyAllowed = path.join(directory, "initially-allowed");
      const deniedAlias = path.join(directory, "denied-alias");
      const alias = path.join(directory, "alias");
      await fs.writeFile(selected, "original");
      await fs.writeFile(initiallyAllowed, "allowed");
      await fs.symlink(selected, alias, "file");
      await fs.symlink(initiallyAllowed, deniedAlias, "file");
      const resolveExisting = existingPath.resolvePathViaExistingAncestor;
      let armed = false;
      let policyRetargeted = false;
      let selectedAdmissionChecks = 0;
      vi.spyOn(existingPath, "resolvePathViaExistingAncestor").mockImplementation(async candidate => {
        const resolved = await resolveExisting(candidate);
        if (policyRetargeted && path.resolve(candidate) === selected) {
          selectedAdmissionChecks += 1;
        }
        if (armed && !policyRetargeted && path.resolve(candidate) === directory) {
          policyRetargeted = true;
          await fs.unlink(deniedAlias);
          await fs.symlink(selected, deniedAlias, "file");
        }
        return resolved;
      });
      let admissions = 0;
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission() {
          admissions += 1;
          expect(policyRetargeted).toBe(false);
          armed = true;
        },
      });
      const callback = vi.fn();
      const open = vi.spyOn(fs, "open");
      const safe = await root(directory);

      await expect(operation.run(safe, "alias", {
        denyMutations: { paths: [deniedAlias] },
        assertBeforeMutation: callback,
      })).rejects.toMatchObject({ code: "denied-path" });

      expect(admissions).toBe(1);
      expect(policyRetargeted).toBe(true);
      expect(selectedAdmissionChecks).toBe(1);
      expect(callback).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(await fs.readFile(selected, "utf8")).toBe("original");
    },
  );

  it.each(followedFinalLinkOperations)(
    "rejects $name when a followed final link retargets during awaited admission",
    async (operation) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-retarget-");
      const selected = path.join(directory, "selected");
      const retarget = path.join(directory, "retarget");
      const alias = path.join(directory, "alias");
      await fs.writeFile(selected, "original");
      await fs.writeFile(retarget, "other");
      await fs.symlink(selected, alias, "file");
      const handles = captureOpenedHandles();
      const callback = vi.fn();
      let admissions = 0;
      __setFsSafeTestHooksForTest({
        async beforePinnedWriteParentAdmission() {
          if (++admissions !== 2) return;
          await fs.unlink(alias);
          await fs.symlink(retarget, alias, "file");
        },
      });
      const safe = await root(directory);

      await expect(operation.run(safe, "alias", {
        denyMutations: { paths: [path.join(directory, "unrelated")] },
        assertBeforeMutation: callback,
      })).rejects.toMatchObject({ code: "path-mismatch" });

      expect(admissions).toBe(2);
      expect(callback).not.toHaveBeenCalled();
      expect(await fs.readFile(selected, "utf8")).toBe("original");
      expect(await fs.readFile(retarget, "utf8")).toBe("other");
      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect((await fs.readdir(directory)).filter((entry) => entry.startsWith(".fs-safe-")))
        .toEqual([]);
    },
  );

  it.each(followedFinalLinkOperations)(
    "preserves a stable followed final link for $name",
    async (operation) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-stable-link-");
      const selected = path.join(directory, "selected");
      const alias = path.join(directory, "alias");
      await fs.writeFile(selected, "original");
      await fs.symlink(selected, alias, "file");
      const handles = captureOpenedHandles();
      const safe = await root(directory);

      await operation.run(safe, "alias", {
        denyMutations: { paths: [path.join(directory, "unrelated")] },
      });

      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(selected, "utf8")).toBe(
        operation.name === "openWritable-replace" ? ""
          : operation.name === "append" ? "originalpayload" : "original",
      );
      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    },
  );

  it("preserves mkdir:false and ensureRoot behavior with policy admission enabled", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-semantics-");
    const safe = await root(directory);
    const policy = { paths: [path.join(directory, "future")] };

    await expect(safe.openWritable("missing/value", {
      mkdir: false,
      denyMutations: policy,
    })).rejects.toMatchObject({ code: "not-found" });
    await expect(fs.lstat(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(safe.ensureRoot({ denyMutations: policy })).resolves.toBeUndefined();
    await expect(safe.ensureRoot({
      denyMutations: { paths: [directory] },
    })).rejects.toMatchObject({ code: "denied-path" });
  });

  it("does not dispatch a callback or file open when mkdir:false has no exact parent", async () => {
    const directory = await tempRoot("fs-safe-shared-policy-missing-parent-");
    const callback = vi.fn();
    const open = vi.spyOn(fs, "open");
    const safe = await root(directory);

    await expect(safe.openWritable("missing/value", {
      mkdir: false,
      denyMutations: { paths: [path.join(directory, "unrelated")] },
      assertBeforeMutation: callback,
    })).rejects.toMatchObject({ code: "not-found" });

    expect(callback).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
