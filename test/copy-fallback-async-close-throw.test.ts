import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { replaceFileAtomic, type ReplaceFileAtomicFileSystem } from "../src/atomic.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const PRIMARY_FAILURES = [
  { label: "Error with cause", value: new FsSafeError("path-mismatch", "primary admission failure", { cause: new Error("primary cause") }) },
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "zero", value: 0 },
  { label: "negative zero", value: -0 },
  { label: "bigint zero", value: 0n },
  { label: "empty string", value: "" },
  { label: "NaN", value: Number.NaN },
] as const;
const PHASES = ["source-admission", "source-read", "hardlink-admission", "restore-admission"] as const;
type Phase = typeof PHASES[number];
type Delivery = "throw" | "reject";
const CLOSE_CASES = PRIMARY_FAILURES.flatMap(failure =>
  (["throw", "reject"] as const).map(delivery => ({ ...failure, delivery })));

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runPublicAdapter(params: {
  dest: string;
  phase: Phase;
  delivery: Delivery;
  closeFailure: unknown;
  primary?: { value: unknown };
}) {
  let stage: string | undefined;
  let closeCalls = 0;
  const borrowed: FileHandle[] = [];
  const fileSystem: ReplaceFileAtomicFileSystem = {
    promises: {
      ...fs,
      async rename() {
        throw Object.assign(new Error("force copy fallback"), { code: "EPERM" });
      },
      async open(...args: Parameters<typeof fs.open>) {
        const handle = await fs.open(...args);
        const isSource = String(args[0]) === stage && typeof args[1] === "number";
        const selected = params.phase.startsWith("source")
          ? isSource
          : String(args[0]) === params.dest;
        if (!selected) return handle;
        borrowed.push(handle);
        const fail = () => { throw params.primary!.value; };
        return bindHandle(handle, {
          ...(params.primary ? params.phase === "source-read"
            ? { readFile: fail as FileHandle["readFile"] }
            : { stat: fail as FileHandle["stat"] }
            : {}),
          close() {
            closeCalls += 1;
            if (params.delivery === "throw") throw params.closeFailure;
            return Promise.reject(params.closeFailure);
          },
        });
      },
    },
  };
  let outcome: { ok: true; method: string } | { ok: false; error: unknown };
  try {
    const result = await replaceFileAtomic({
      filePath: params.dest,
      content: "replacement",
      fileSystem,
      copyFallbackOnPermissionError: true,
      ...(params.phase === "hardlink-admission" ? { destinationHardlinks: "reject" } : {}),
      ...(params.phase === "restore-admission" ? {
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 64,
      } : {}),
      syncTempFile: false,
      beforeRename: async (receipt) => { stage = receipt.tempPath; },
    });
    outcome = { ok: true, method: result.method };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    // Injected close failures intentionally leave the real handles for the fixture.
    await Promise.all(borrowed.map(handle => handle.close()));
  }
  return { outcome, closeCalls, stage };
}

describe.each(PHASES)("async copy-fallback %s close precedence", (phase) => {
  it.each(CLOSE_CASES)("preserves $label when close uses $delivery", async ({ value, delivery }) => {
    const root = await tempRoot("fs-safe-async-copy-close-primary-");
    const dest = path.join(root, delivery);
    await fs.writeFile(dest, "original");
    const result = await runPublicAdapter({
      dest,
      phase,
      delivery,
      closeFailure: new Error("secondary close failure"),
      primary: { value },
    });

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) expect(Object.is(result.outcome.error, value)).toBe(true);
    expect(result.closeCalls).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    expect(result.stage).toBeDefined();
    expect(fsSync.existsSync(result.stage!)).toBe(false);
  });
});

describe("async copy-fallback source best-effort close", () => {
  it.each(CLOSE_CASES)("does not promote $label when close uses $delivery after a successful source read", async ({ value, delivery }) => {
    const root = await tempRoot("fs-safe-async-copy-close-source-");
    const dest = path.join(root, delivery);
    await fs.writeFile(dest, "original");
    const result = await runPublicAdapter({
      dest,
      phase: "source-read",
      delivery,
      closeFailure: value,
    });

    expect(result.outcome).toEqual({ ok: true, method: "copy-fallback" });
    expect(result.closeCalls).toBe(1);
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("replacement");
    expect(result.stage).toBeDefined();
    expect(fsSync.existsSync(result.stage!)).toBe(false);
  });
});
