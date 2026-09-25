import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retainSymlinkInDirectory, type StagedSymlinkExpected } from "../src/advanced.js";
import { FsSafeError, type FsSafeErrorCode } from "../src/errors.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest, __resetNativeLoaderForTest, type NativeBinding,
} from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const supported = process.platform === "linux" || process.platform === "darwin";
let binding: NativeBinding | undefined;
try { binding = __loadBundledNativeForTest(); } catch {
  if (supported && process.env.FS_SAFE_NATIVE_MODE === "require") throw new Error("native binding required");
}
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

function identity(directory: string, name: string) {
  const { dev, ino } = fs.lstatSync(path.join(directory, name), { bigint: true });
  return { dev, ino };
}

async function fixture(assertBeforeMutation: () => void) {
  const directory = await tempRoot("fs-safe-symlink-errors-");
  fs.mkdirSync(path.join(directory, "runtime"));
  fs.writeFileSync(path.join(directory, "runtime", "sentinel"), "untouched");
  fs.symlinkSync("runtime", path.join(directory, "stage"));
  const stat = fs.lstatSync(path.join(directory, "stage"), { bigint: true });
  const expected = {
    dev: stat.dev, ino: stat.ino, uid: Number(stat.uid), gid: Number(stat.gid),
    ctimeNs: stat.ctimeNs, target: "runtime",
  } satisfies StagedSymlinkExpected;
  let parentFd = -1;
  let linkFd = -1;
  const open = binding!.openStagedSymlink!;
  vi.spyOn(binding!, "openStagedSymlink").mockImplementation((...args) => {
    parentFd = args[0];
    return linkFd = open(...args);
  });
  // Admission captures this close function, so observe it before retaining.
  const closeLink = vi.spyOn(binding!, "closeOwnedFd");
  const owner = await retainSymlinkInDirectory({
    directory, basename: "stage", expected, assertBeforeMutation,
  });
  const closeParent = vi.spyOn(fs, "closeSync");
  function assertClosedOnce() {
    expect(closeLink.mock.calls.filter(([fd]) => fd === linkFd)).toHaveLength(1);
    expect(closeParent.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
    expect(() => fs.fstatSync(linkFd)).toThrow();
    expect(() => fs.fstatSync(parentFd)).toThrow();
  }
  return { directory, expected, owner, assertClosedOnce };
}

async function rejection(operation: Promise<unknown>): Promise<{ error: unknown }> {
  return operation.then(
    () => { throw new Error("expected staged symlink operation to reject"); },
    (error: unknown) => ({ error }),
  );
}

function assertWrapped(error: unknown, cause: unknown, code: FsSafeErrorCode): FsSafeError {
  let wrapped = false;
  try { wrapped = error instanceof FsSafeError; } catch { /* A raw hostile value is not a wrapper. */ }
  expect(wrapped).toBe(true);
  const result = error as FsSafeError;
  expect(result.code).toBe(code);
  // Do not let an assertion formatter inspect the hostile cause, even on failure.
  expect(result.cause === cause).toBe(true);
  return result;
}

const hostileErrors = [
  {
    label: "throwing code getter",
    create: () => Object.defineProperty(new Error("caller failure"), "code", {
      get() { throw new Error("code must not escape classification"); },
    }),
  },
  {
    label: "revoked proxy",
    create: () => {
      const { proxy, revoke } = Proxy.revocable(new Error("caller failure"), {});
      revoke();
      return proxy;
    },
  },
  {
    label: "throwing prototype lookup",
    create: () => new Proxy(new Error("caller failure"), {
      getPrototypeOf() { throw new Error("prototype must not escape classification"); },
    }),
  },
];
type FailureSite = "authority" | "match" | "unlink";
const cases: { label: string; create(): unknown; site: FailureSite; code: FsSafeErrorCode }[] = [
  ...hostileErrors.flatMap((error) => (["authority", "match", "unlink"] as const).map((site) => ({
    ...error, label: `hostile error metadata: ${error.label} from ${site}`, site, code: "helper-failed" as const,
  }))),
  {
    label: "ordinary FsSafeError authority rejection", site: "authority", code: "path-mismatch",
    create: () => new FsSafeError("path-mismatch", "caller policy rejected mutation"),
  },
  {
    label: "ordinary EEXIST unlink error", site: "unlink", code: "already-exists",
    create: () => Object.assign(new Error("native collision"), { code: "EEXIST" }),
  },
];

describe.runIf(supported && !!binding)("retained symlink error settlement", () => {
  for (const phase of ["cleanup", "remove-published"] as const) {
    it.each(cases)(`${phase} settles and caches $label`, async ({ create, site, code }) => {
      const cause = create();
      let armed = false;
      const authority = vi.fn(() => {
        if (armed && site === "authority") throw cause;
      });
      const { directory, expected, owner, assertClosedOnce } = await fixture(authority);
      try {
        const publication = phase === "remove-published" ? await owner.publish("slot") : undefined;
        const name = publication ? "slot" : "stage";
        const matches = binding!.stagedSymlinkMatches!;
        const match = vi.spyOn(binding!, "stagedSymlinkMatches").mockImplementation((...args) => {
          if (armed && site === "match") throw cause;
          return matches(...args);
        });
        const unlink = binding!.removeStagedSymlink!;
        const remove = vi.spyOn(binding!, "removeStagedSymlink").mockImplementation((...args) => {
          if (armed && site === "unlink") throw cause;
          return unlink(...args);
        });
        authority.mockClear();
        armed = true;
        const first = await rejection(publication ? owner.removePublished() : owner.cleanup());
        const error = assertWrapped(first.error, cause, code);
        expect(error.details?.phase).toBe(phase);
        expect(error.details?.publication).toEqual(publication ?? { status: "not-published" });
        if (publication) {
          expect(error.details?.publication === publication).toBe(true);
          expect(error.details?.cleanup).toBeUndefined();
        } else {
          expect(error.details?.cleanup).toEqual({
            temporaryBasename: "stage", publication: { status: "not-published" },
            status: "failed", resources: "closed",
          });
          expect(Object.isFrozen(error.details?.cleanup)).toBe(true);
          assertClosedOnce();
        }
        expect(authority).toHaveBeenCalledTimes(site === "match" ? 0 : 1);
        expect(match).toHaveBeenCalledTimes(site === "unlink" ? 2 : 1);
        expect(remove).toHaveBeenCalledTimes(site === "unlink" ? 1 : 0);
        expect(identity(directory, name)).toEqual({ dev: expected.dev, ino: expected.ino });
        expect(fs.readlinkSync(path.join(directory, name))).toBe("runtime");
        expect(fs.readdirSync(directory).sort()).toEqual(["runtime", name].sort());

        armed = false;
        // A cached failure must not gain authority over a later replacement.
        fs.renameSync(path.join(directory, name), path.join(directory, "original"));
        fs.symlinkSync("runtime", path.join(directory, name));
        const foreign = identity(directory, name);
        const repeated = await rejection(publication ? owner.removePublished() : owner.cleanup());
        expect(repeated.error === error).toBe(true);
        if (publication) {
          const cleanup = await owner.cleanup();
          expect(cleanup).toEqual({
            temporaryBasename: "stage", publication, status: "not-needed", resources: "closed",
          });
          expect(cleanup.publication === publication).toBe(true);
          expect(await owner.cleanup() === cleanup).toBe(true);
          await owner[Symbol.asyncDispose]();
        } else {
          const disposal = await rejection(owner[Symbol.asyncDispose]());
          expect(disposal.error === error).toBe(true);
        }
        expect(authority).toHaveBeenCalledTimes(site === "match" ? 0 : 1);
        expect(match).toHaveBeenCalledTimes(site === "unlink" ? 2 : 1);
        expect(remove).toHaveBeenCalledTimes(site === "unlink" ? 1 : 0);
        assertClosedOnce();
        expect(identity(directory, name)).toEqual(foreign);
        expect(identity(directory, "original")).toEqual({ dev: expected.dev, ino: expected.ino });
        expect(fs.readlinkSync(path.join(directory, name))).toBe("runtime");
        expect(fs.readFileSync(path.join(directory, "runtime", "sentinel"), "utf8")).toBe("untouched");
      } finally {
        armed = false;
        await owner.cleanup().catch(() => {});
      }
    });
  }

  for (const timing of ["before", "after"] as const) {
    it.each(hostileErrors)(`publish settles hostile error metadata: $label ${timing} native rename`, async ({ create }) => {
      const cause = create();
      const authority = vi.fn(() => {});
      const { directory, expected, owner, assertClosedOnce } = await fixture(authority);
      const nativePublish = binding!.publishStagedSymlink!;
      let armed = true;
      const publish = vi.spyOn(binding!, "publishStagedSymlink").mockImplementation((...args) => {
        if (!armed) return nativePublish(...args);
        if (timing === "after") nativePublish(...args);
        throw cause;
      });
      const match = vi.spyOn(binding!, "stagedSymlinkMatches");
      const target = vi.spyOn(binding!, "stagedSymlinkTarget");
      const remove = vi.spyOn(binding!, "removeStagedSymlink");
      authority.mockClear();
      try {
        const first = await rejection(owner.publish("slot"));
        const error = assertWrapped(first.error, cause, "helper-failed");
        const publication = error.details?.publication;
        expect(error.details?.phase).toBe("publish");
        expect(publication).toEqual({ status: "indeterminate", basename: "slot", overwrite: false });
        expect(Object.isFrozen(publication)).toBe(true);
        expect(error.details?.cleanup).toBeUndefined();
        const name = timing === "before" ? "stage" : "slot";
        expect(fs.readdirSync(directory).sort()).toEqual(["runtime", name].sort());
        expect(identity(directory, name)).toEqual({ dev: expected.dev, ino: expected.ino });

        armed = false;
        // Check settlement while still open; a closed-owner error could hide a retry.
        const recovery = await rejection(owner.removePublished());
        assertWrapped(recovery.error, undefined, "helper-failed");
        const retry = await rejection(owner.publish("retry"));
        expect(retry.error instanceof FsSafeError).toBe(true);
        const retryError = retry.error as FsSafeError;
        expect(retryError.code).toBe("helper-failed");
        expect(retryError.details).toEqual({ phase: "publish", publication });
        expect(retryError.details?.publication === publication).toBe(true);

        const cleanup = await owner.cleanup();
        expect(cleanup).toEqual({
          temporaryBasename: "stage", publication, status: "preserved", resources: "closed",
        });
        expect(Object.isFrozen(cleanup)).toBe(true);
        expect(cleanup.publication === publication).toBe(true);
        expect(await owner.cleanup() === cleanup).toBe(true);
        const disposal = await rejection(owner[Symbol.asyncDispose]());
        const disposalError = assertWrapped(disposal.error, undefined, "not-removable");
        expect(disposalError.details?.cleanup === cleanup).toBe(true);
        expect(authority).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(match).toHaveBeenCalledTimes(2);
        expect(target).toHaveBeenCalledTimes(2);
        expect(remove).not.toHaveBeenCalled();
        assertClosedOnce();
        expect(fs.readdirSync(directory).sort()).toEqual(["runtime", name].sort());
        expect(identity(directory, name)).toEqual({ dev: expected.dev, ino: expected.ino });
        expect(fs.readlinkSync(path.join(directory, name))).toBe("runtime");
        expect(fs.readFileSync(path.join(directory, "runtime", "sentinel"), "utf8")).toBe("untouched");
      } finally {
        armed = false;
        await owner.cleanup().catch(() => {});
      }
    });
  }
});
