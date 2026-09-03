import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  acquireFileLockSync,
  createFileLockManager,
  type FileLockSyncAcquireOptions,
} from "../src/file-lock.js";
import * as nativeOperations from "../src/native-operations.js";
import { root } from "../src/root.js";
import { readSidecarLockOwnershipToken, serializeSidecarLockPayload } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const cap = 1024 * 1024;
const overhead = Buffer.byteLength(serializeSidecarLockPayload({ data: "" }).raw, "utf8");
const encodings = ["ASCII", "multibyte"] as const;
type Encoding = typeof encodings[number];
type AcquireOptions = FileLockSyncAcquireOptions<Record<string, unknown>>;
const budgets = [
  { name: "finite deadline and retries", timeoutMs: 1000, retry: { retries: 2 } },
  { name: "infinite deadline and finite retries", timeoutMs: Infinity, retry: { retries: 2 } },
  { name: "infinite deadline and retries", timeoutMs: Infinity, retry: {} },
  { name: "omitted deadline and retries", timeoutMs: undefined, retry: {} },
];

afterEach(() => vi.restoreAllMocks());

function sizedPayload(bytes: number, encoding: Encoding) {
  const dataBytes = bytes - overhead;
  const data = encoding === "ASCII"
    ? "x".repeat(dataBytes)
    : "🦞".repeat(Math.floor(dataBytes / 4)) + "x".repeat(dataBytes % 4);
  return { data };
}

describe("serialized sidecar payload byte admission", () => {
  for (const encoding of encodings) {
    it.each([cap - 1, cap, cap + 1])(`${encoding}: %s complete UTF-8 bytes`, (bytes) => {
      const payload = sizedPayload(bytes, encoding);
      if (encoding === "multibyte") expect(payload.data.length).toBeLessThan(cap / 2);
      if (bytes > cap) {
        expect(() => serializeSidecarLockPayload(payload))
          .toThrow(expect.objectContaining({ name: "FsSafeError", code: "too-large" }));
      } else {
        const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
        expect(Buffer.byteLength(raw, "utf8")).toBe(bytes);
        expect(raw).toBe(`${JSON.stringify(payload, null, 2)}\n${ownershipToken}\n`);
        expect(readSidecarLockOwnershipToken(raw)).toBe(ownershipToken);
        expect(JSON.parse(raw)).toEqual(payload);
      }
    });
  }
});

for (const mode of ["raw async", "Root async", "raw sync", "Root sync"] as const) {
  describe(`${mode} sidecar payload admission`, () => {
    async function fixture() {
      const directory = await tempRoot("fs-safe-lock-payload-");
      const target = path.join(directory, "state");
      const lockPath = `${target}.lock`;
      const lockRoot = mode.startsWith("Root") ? await root(directory) : undefined;
      const manager = createFileLockManager(`payload:${target}`);
      const acquire = async (options: AcquireOptions) => mode.endsWith("async")
        ? await manager.acquire(target, { ...options, lockRoot })
        : acquireFileLockSync(target, { ...options, lockRoot });
      const expectHeld = (count: number) => {
        if (mode.endsWith("async")) {
          expect(manager.heldEntries()).toHaveLength(count);
        } else {
          // Sync locks have no public diagnostics; inspect only this fixture's entry.
          const held = Reflect.get(globalThis, Symbol.for("fsSafe.syncSidecarLocks")) as
            Map<string, unknown> | undefined;
          expect(held?.has(target) ?? false).toBe(count === 1);
        }
      };
      const expectEmpty = async () => {
        expectHeld(0);
        expect(await fs.readdir(directory)).toEqual([]);
      };
      const expectUsable = async () => {
        const payload = vi.fn(() => ({ owner: "later valid acquisition" }));
        const lock = await acquire({ payload, retry: { retries: 0 } });
        try {
          expect(payload).toHaveBeenCalledTimes(1);
          expectHeld(1);
          expect(await lock.verifyStillHeld()).toBe(true);
        } finally {
          await lock.release();
        }
        await expectEmpty();
      };
      const observeCreation = () => {
        const spies = [
          vi.spyOn(fs, "open"),
          vi.spyOn(fsSync, "openSync"),
          vi.spyOn(nativeOperations, "createNativeExclusiveFile"),
          ...(lockRoot ? [vi.spyOn(lockRoot, "create")] : []),
        ];
        return () => {
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
          for (const spy of spies) spy.mockRestore();
        };
      };
      return { directory, lockPath, acquire, expectHeld, expectEmpty, expectUsable, observeCreation };
    }

    for (const encoding of encodings) {
      it.each([cap - 1, cap])(`writes and releases ${encoding} at %s bytes`, async (bytes) => {
        const { lockPath, acquire, expectHeld, expectEmpty } = await fixture();
        const value = sizedPayload(bytes, encoding);
        const toJSON = vi.fn(() => value);
        const payload = vi.fn(() => ({ toJSON }));
        const lock = await acquire({ payload, retry: { retries: 0 } });
        try {
          const raw = await fs.readFile(lockPath, "utf8");
          expect((await fs.stat(lockPath)).size).toBe(bytes);
          expect(Buffer.byteLength(raw, "utf8")).toBe(bytes);
          expect(JSON.parse(raw)).toEqual(value);
          const token = readSidecarLockOwnershipToken(raw);
          expect(token).toBeDefined();
          expect(raw).toBe(`${JSON.stringify(value, null, 2)}\n${token}\n`);
          expectHeld(1);
          expect(await lock.verifyStillHeld()).toBe(true);
        } finally {
          await lock.release();
        }
        expect(payload).toHaveBeenCalledTimes(1);
        expect(toJSON).toHaveBeenCalledTimes(1);
        await expectEmpty();
      });

      for (const budget of budgets) {
        it.each([false, true])(
          `refuses ${encoding} at cap+1 with ${budget.name} (foreign sidecar: %s)`,
          async (foreign) => {
            const { directory, lockPath, acquire, expectHeld, expectEmpty, expectUsable, observeCreation } =
              await fixture();
            const original = '{"owner":"foreign","createdAt":"2000-01-01T00:00:00.000Z"}\n';
            if (foreign) await fs.writeFile(lockPath, original, { flag: "wx" });
            const before = foreign ? await fs.stat(lockPath, { bigint: true }) : undefined;
            const noCreation = observeCreation();
            const toJSON = vi.fn(() => sizedPayload(cap + 1, encoding));
            const payload = vi.fn(() => ({ toJSON }));
            const parsePayload = vi.fn(JSON.parse);
            const shouldReclaim = vi.fn(() => true);
            const shouldRemoveStaleLock = vi.fn(() => true);
            const error = await acquire({
              ...budget,
              payload,
              parsePayload,
              staleRecovery: "remove-if-unchanged",
              shouldReclaim,
              shouldRemoveStaleLock,
            }).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(FsSafeError);
            expect(error).toMatchObject({ code: "too-large" });
            expect(payload).toHaveBeenCalledTimes(1);
            expect(toJSON).toHaveBeenCalledTimes(1);
            expect(parsePayload).not.toHaveBeenCalled();
            expect(shouldReclaim).not.toHaveBeenCalled();
            expect(shouldRemoveStaleLock).not.toHaveBeenCalled();
            noCreation();
            expectHeld(0);
            if (foreign) {
              const after = await fs.stat(lockPath, { bigint: true });
              expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs])
                .toEqual([before!.dev, before!.ino, before!.size, before!.mtimeNs, before!.ctimeNs]);
              expect(await fs.readFile(lockPath, "utf8")).toBe(original);
              expect(await fs.readdir(directory)).toEqual(["state.lock"]);
              await fs.unlink(lockPath);
            }
            await expectEmpty();
            await expectUsable();
          },
        );
      }
    }

    for (const budget of budgets) {
      it.each(["payload", "toJSON"] as const)(
        `preserves %s error identity without retry with ${budget.name}`,
        async (callback) => {
          const { acquire, expectEmpty, expectUsable, observeCreation } = await fixture();
          const noCreation = observeCreation();
          const failure = Object.assign(new Error("caller serialization failure"), { code: "EEXIST" });
          // A distinct second-call error bounds a broken infinite-budget loop.
          const fail = vi.fn((): never => { throw new Error("callback was retried"); })
            .mockImplementationOnce(() => { throw failure; });
          const payload = callback === "payload" ? fail : vi.fn(() => ({ toJSON: fail }));
          await expect(acquire({ ...budget, payload })).rejects.toBe(failure);
          expect(payload).toHaveBeenCalledTimes(1);
          expect(fail).toHaveBeenCalledTimes(1);
          noCreation();
          await expectEmpty();
          await expectUsable();
        },
      );
    }
  });
}
