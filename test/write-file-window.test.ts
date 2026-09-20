import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { writeFileWindowFully, type WriteFileWindowOptions } from "../src/advanced.js";
import { useFileHandleTransferFixture } from "./helpers/file-handle-transfer.js";

const { fixture } = useFileHandleTransferFixture();

describe("borrowed FileHandle write windows", () => {
  it.each([null, 2])("completes short writes from a byte view at position %s and preserves caller ownership", async position => {
    const f = await fixture("", "abcdefgh");
    await f.target.read(Buffer.alloc(1), 0, 1, null);
    const before = await f.target.stat();
    const backing = Buffer.from("beforeWXYZafter");
    const bytes = new Uint8Array(backing.buffer, backing.byteOffset + 6, 4);
    const original = f.target.write.bind(f.target);
    vi.spyOn(f.target, "write").mockImplementation(async (buffer, offset, length, start) =>
      await original(buffer, offset, Math.min(length, 2), start));

    await writeFileWindowFully(f.target, bytes, position);

    expect(await fs.readFile(f.targetPath, "utf8")).toBe(position === null ? "aWXYZfgh" : "abWXYZgh");
    const after = await f.target.stat();
    expect({ dev: after.dev, ino: after.ino, mode: after.mode, size: after.size })
      .toEqual({ dev: before.dev, ino: before.ino, mode: before.mode, size: before.size });
    const next = Buffer.alloc(1);
    await f.target.read(next, 0, 1, null);
    expect(next.toString()).toBe(position === null ? "f" : "b");
    expect(backing.toString()).toBe("beforeWXYZafter");
  });

  it.each(["view", "buffer"] as const)("uses intrinsic %s bounds for writing and overflow admission", async kind => {
    const f = await fixture("", "abcdefgh");
    const backing = Buffer.from("!WXY?");
    const bytes = kind === "buffer" ? backing.subarray(1, 4) : new Uint8Array(backing.buffer, backing.byteOffset + 1, 3);
    const shadowed = vi.fn(() => 0);
    Object.defineProperties(bytes, {
      byteLength: { get: shadowed }, length: { get: shadowed },
      buffer: { get: shadowed }, byteOffset: { get: shadowed }, subarray: { get: shadowed },
    });
    await writeFileWindowFully(f.target, bytes, 2);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("abWXYfgh");
    const assertion = vi.fn();
    await expect(writeFileWindowFully(f.target, bytes, Number.MAX_SAFE_INTEGER, { assertBeforeMutation: assertion }))
      .rejects.toBeInstanceOf(RangeError);
    expect(assertion).not.toHaveBeenCalled();
    expect(shadowed).not.toHaveBeenCalled();
    expect(backing.toString()).toBe("!WXY?");
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid position or overflowing window %s before authority or I/O", async position => {
      const f = await fixture();
      const write = vi.spyOn(f.target, "write");
      const assertBeforeMutation = vi.fn();
      await expect(writeFileWindowFully(f.target, Buffer.from("ab"), position, { assertBeforeMutation }))
        .rejects.toBeInstanceOf(RangeError);
      expect(write).not.toHaveBeenCalled();
      expect(assertBeforeMutation).not.toHaveBeenCalled();
      expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
    },
  );

  it("admits an empty window without using the handle or authority callback", async () => {
    const f = await fixture();
    await f.target.close();
    const assertBeforeMutation = vi.fn();
    await writeFileWindowFully(f.target, Buffer.alloc(0), Number.MAX_SAFE_INTEGER, { assertBeforeMutation });
    expect(assertBeforeMutation).not.toHaveBeenCalled();
    const reason = new Error("empty operation cancelled");
    await expect(writeFileWindowFully(f.target, Buffer.alloc(0), null, { signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason);
  });

  it.each(["zero progress", "filesystem error"] as const)("preserves completed bytes on %s without rolling back", async outcome => {
    const f = await fixture("", "abcdefgh");
    const original = f.target.write.bind(f.target);
    const failure = Object.assign(new Error("synthetic I/O failure"), { code: "EIO" });
    const write = vi.spyOn(f.target, "write")
      .mockImplementationOnce(async (buffer, offset, _length, position) => await original(buffer, offset, 2, position))
      .mockImplementationOnce(async buffer => {
        if (outcome === "filesystem error") throw failure;
        return { bytesWritten: 0, buffer };
      });
    const operation = writeFileWindowFully(f.target, Buffer.from("WXYZ"), 1);
    if (outcome === "filesystem error") await expect(operation).rejects.toBe(failure);
    else await expect(operation).rejects.toMatchObject({ code: "helper-failed", message: "file write made no progress" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("aWXdefgh");
    expect((await f.target.stat()).size).toBe(8);
  });

  it("retains the original authority callback and its receiver across short writes", async () => {
    const f = await fixture("", "abcdefgh");
    const rejection = new Error("owner released");
    let allowed = true;
    const options: WriteFileWindowOptions = {
      assertBeforeMutation() {
        expect(this).toBe(options);
        if (!allowed) throw rejection;
      },
    };
    const original = f.target.write.bind(f.target);
    const write = vi.spyOn(f.target, "write").mockImplementationOnce(async (buffer, offset, _length, position) => {
      const result = await original(buffer, offset, 2, position);
      allowed = false;
      options.assertBeforeMutation = () => {};
      return result;
    });
    await expect(writeFileWindowFully(f.target, Buffer.from("WXYZ"), 1, options)).rejects.toBe(rejection);
    expect(write).toHaveBeenCalledOnce();
    expect(await fs.readFile(f.targetPath, "utf8")).toBe("aWXdefgh");
  });

  it.each([
    { name: "async callback", callback: async () => {} },
    { name: "rejected async callback", callback: async () => { throw new Error("late denial"); } },
    { name: "thenable callback", callback: () => ({ then(resolve: () => void) { resolve(); } }) },
  ])("rejects a $name before mutation", async ({ callback }) => {
    const f = await fixture();
    const write = vi.spyOn(f.target, "write");
    await expect(writeFileWindowFully(f.target, Buffer.from("new"), 0, { assertBeforeMutation: callback }))
      .rejects.toEqual(new TypeError("assertBeforeMutation must be synchronous"));
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["before admission", "inside authority"] as const)("honors cancellation %s before writing", async phase => {
    const f = await fixture();
    const controller = new AbortController();
    const reason = new Error("write cancelled");
    if (phase === "before admission") controller.abort(reason);
    const write = vi.spyOn(f.target, "write");
    const assertBeforeMutation = vi.fn(() => controller.abort(reason));
    await expect(writeFileWindowFully(f.target, Buffer.from("new"), 0, { signal: controller.signal, assertBeforeMutation }))
      .rejects.toBe(reason);
    if (phase === "before admission") expect(assertBeforeMutation).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(f.targetPath, "utf8")).toBe(f.prior);
  });

  it.each(["short write", "last write", "filesystem failure", "zero progress"] as const)(
    "settles a pending %s before cancellation and preserves an independent write failure", async outcome => {
      const f = await fixture("", "abcdefgh");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      const reason = new Error("write cancelled");
      const failure = Object.assign(new Error("independent I/O failure"), { code: "EIO" });
      const original = f.target.write.bind(f.target);
      const write = vi.spyOn(f.target, "write").mockImplementationOnce(async (buffer, offset, length, position) => {
        entered.resolve();
        await release.promise;
        if (outcome === "filesystem failure") throw failure;
        if (outcome === "zero progress") return { bytesWritten: 0, buffer };
        return await original(buffer, offset, outcome === "short write" ? 2 : length, position);
      });
      const options: WriteFileWindowOptions = { signal: controller.signal };
      let settled = false;
      const operation = writeFileWindowFully(f.target, Buffer.from("WXYZ"), 1, options)
        .catch((error: unknown) => error)
        .finally(() => { settled = true; });
      try {
        await entered.promise;
        controller.abort(reason);
        options.signal = undefined;
        await Promise.resolve();
        expect(settled).toBe(false);
        release.resolve();
        const result = await operation;
        if (outcome === "zero progress") expect(result).toMatchObject({ code: "helper-failed", message: "file write made no progress" });
        else expect(result).toBe(outcome === "filesystem failure" ? failure : reason);
        expect(write).toHaveBeenCalledOnce();
        expect(await fs.readFile(f.targetPath, "utf8")).toBe(
          outcome === "filesystem failure" || outcome === "zero progress" ? "abcdefgh" : outcome === "short write" ? "aWXdefgh" : "aWXYZfgh",
        );
        expect((await f.target.stat()).size).toBe(8);
      } finally {
        release.resolve();
        await operation;
      }
    },
  );
});
