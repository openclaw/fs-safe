import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  type FileLockSyncAcquireOptions,
} from "../src/file-lock.js";
import { root, type Root } from "../src/root.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root entry snapshots", () => {
  it.each([false, true])("preserves policy getter and validation order with replaced Root=%s", async (replaceRoot) => {
    const parent = await tempRoot("fs-safe-sync-root-policy-order-");
    const directory = path.join(parent, "root");
    fs.mkdirSync(directory);
    const lockRoot = await root(directory);
    const reads: string[] = [];
    Object.defineProperties(lockRoot.defaults, {
      mutationSymlinks: { get: () => { reads.push("mutation"); return "invalid"; } },
      symlinks: { get: () => { reads.push("read"); return "reject"; } },
    });
    if (replaceRoot) {
      fs.renameSync(directory, path.join(parent, "previous-root"));
      fs.mkdirSync(directory);
    }
    const payload = vi.fn(() => ({ owner: "test" }));
    const acquire = () => acquireFileLockSync(path.join(directory, "state.json"), {
      ...immediate,
      lockRoot,
      payload,
    });

    if (replaceRoot) expect(acquire).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    else expect(acquire).toThrow("mutationSymlinks must be reject or follow-parents-within-root");
    expect(reads).toEqual(["mutation", "read"]);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects a structural Root before reading any remaining option getter", async () => {
    const directory = await tempRoot("fs-safe-sync-root-entry-structural-");
    const genuine = await root(directory);
    const structural = Object.create(genuine) as Root;
    const lockPath = path.join(directory, "state.lock");
    const payload = vi.fn(() => ({ owner: "test" }));
    const getter = vi.fn();
    const retry = {} as NonNullable<FileLockSyncAcquireOptions<{ owner: string }>["retry"]>;
    Object.defineProperty(retry, "retries", {
      get: () => {
        getter("retry.retries");
        return 0;
      },
    });
    const options = {} as FileLockSyncAcquireOptions<{ owner: string }>;
    let lockRootReads = 0;
    Object.defineProperty(options, "lockRoot", {
      get: () => {
        lockRootReads += 1;
        return structural;
      },
    });
    for (const [name, value] of Object.entries({
      lockPath,
      staleMs: 0,
      timeoutMs: 0,
      retry,
      staleRecovery: "fail-closed",
      reentrantOwner: "owner",
      payload,
      shouldReclaim: undefined,
      shouldRemoveStaleLock: undefined,
      parsePayload: undefined,
      onCompromised: undefined,
      compromiseCheckIntervalMs: 0,
    })) {
      Object.defineProperty(options, name, {
        get: () => {
          getter(name);
          return value;
        },
      });
    }

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), options)).toThrow(
      expect.objectContaining({ code: "helper-unavailable" }),
    );
    expect(lockRootReads).toBe(1);
    expect(getter).not.toHaveBeenCalled();
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("retains a deny snapshot when the lockPath getter clears Root policy", async () => {
    const directory = await tempRoot("fs-safe-sync-root-entry-deny-");
    const lockPath = path.join(directory, "state.lock");
    const deniedPaths = [lockPath];
    const lockRoot = await root(directory, { denyMutations: { paths: deniedPaths } });
    const payload = vi.fn(() => ({ owner: "test" }));
    const mutateDefaults = vi.fn(() => {
      deniedPaths.length = 0;
      lockRoot.defaults.denyMutations = undefined;
      return lockPath;
    });
    const options: FileLockSyncAcquireOptions<{ owner: string }> = {
      ...immediate,
      lockRoot,
      payload,
    };
    Object.defineProperty(options, "lockPath", { get: mutateDefaults });

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), options)).toThrow(
      expect.objectContaining({ code: "denied-path" }),
    );
    expect(mutateDefaults).toHaveBeenCalledTimes(1);
    expect(deniedPaths).toEqual([]);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  itPosix("retains the read-link snapshot when an option getter relaxes Root policy", async () => {
    const directory = await tempRoot("fs-safe-sync-root-entry-link-");
    const canonicalLockPath = path.join(directory, "canonical.lock");
    const aliasLockPath = path.join(directory, "alias.lock");
    fs.writeFileSync(canonicalLockPath, "{}");
    fs.symlinkSync(path.basename(canonicalLockPath), aliasLockPath, "file");
    const lockRoot = await root(directory, { symlinks: "reject" });
    const payload = vi.fn(() => ({ owner: "test" }));
    const options: FileLockSyncAcquireOptions<{ owner: string }> = {
      ...immediate,
      lockPath: aliasLockPath,
      lockRoot,
      payload,
    };
    const relaxReadPolicy = vi.fn(() => {
      lockRoot.defaults.symlinks = "follow-within-root";
      return 0;
    });
    Object.defineProperty(options, "timeoutMs", { get: relaxReadPolicy });

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), options)).toThrow(
      expect.objectContaining({ code: "symlink" }),
    );
    expect(relaxReadPolicy).toHaveBeenCalledTimes(1);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.readFileSync(canonicalLockPath, "utf8")).toBe("{}");
  });

  it("retains the hardlink snapshot when a nested retry getter relaxes Root policy", async () => {
    const directory = await tempRoot("fs-safe-sync-root-entry-hardlink-");
    const lockPath = path.join(directory, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    fs.linkSync(lockPath, path.join(directory, "alias.lock"));
    const lockRoot = await root(directory, { hardlinks: "reject" });
    const relaxHardlinkPolicy = vi.fn(() => {
      lockRoot.defaults.hardlinks = "allow";
      return 0;
    });
    const retry = {} as NonNullable<FileLockSyncAcquireOptions<{ owner: string }>["retry"]>;
    Object.defineProperty(retry, "retries", { get: relaxHardlinkPolicy });
    const payload = vi.fn(() => ({ owner: "test" }));

    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      timeoutMs: 0,
      retry,
      lockPath,
      lockRoot,
      payload,
    })).toThrow(expect.objectContaining({ code: "hardlink" }));
    expect(relaxHardlinkPolicy).toHaveBeenCalledTimes(1);
    expect(payload).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
  });
});
