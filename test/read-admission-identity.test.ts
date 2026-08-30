import fsSync, { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegularFile, readRegularFileSync } from "../src/regular-file.js";
import { openRootFile, openRootFileSync } from "../src/root-file.js";
import { observeReadAdmission, readIdentity, type ReadBoundary } from "./helpers/read-admission-identity.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

for (const route of ["regular async", "regular sync", "root sync", "root async"] as const) {
  describe(route, () => {
    async function fixture(options: Parameters<typeof observeReadAdmission>[1] = {}) {
      const directory = await fs.realpath(await tempRoot("fs-safe-read-admission-"));
      const filePath = path.join(directory, "value");
      await fs.writeFile(filePath, "original");
      await fs.writeFile(`${filePath}.replacement`, "replacement");
      const observation = observeReadAdmission(filePath, options);
      const run = async () => {
        if (route === "regular async") return await readRegularFile({ filePath });
        if (route === "regular sync") return readRegularFileSync({ filePath });
        const params = { absolutePath: filePath, rootPath: directory, boundaryLabel: "test", ioFs: fsSync };
        const result = route === "root sync" ? openRootFileSync(params) : await openRootFile(params);
        if (!result.ok) {
          expect(result.reason).toBe("validation");
          throw result.error;
        }
        try { return { stat: result.stat, buffer: fsSync.readFileSync(result.fd) }; }
        finally { fsSync.closeSync(result.fd); }
      };
      return { ...observation, filePath, run };
    }

    it.each(["before-open", "after-open"] as const)("refuses a rounded-equal replacement %s", async (swap) => {
      const subject = await fixture({ swap });
      expect(Number(readIdentity.ino)).toBe(Number(readIdentity.ino + 1n));
      await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(subject.read).not.toHaveBeenCalled();
      expect(subject.close).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(subject.displaced, "utf8")).toBe("original");
      expect(await fs.readFile(subject.filePath, "utf8")).toBe("replacement");
    });

    it("preserves numeric Stats on successful reads", async () => {
      const subject = await fixture();
      const result = await subject.run();
      expect(result.stat).toBeInstanceOf(Stats);
      expect(typeof result.stat.ino).toBe("number");
      expect(result.buffer.toString()).toBe("original");
      expect(subject.close).toHaveBeenCalledTimes(1);
    });

    for (const boundary of ["preview", "descriptor", "current"] as ReadBoundary[]) {
      it(`retries a transient Windows ${boundary} once without reopening`, async () => {
        const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }, {}] } });
        Object.defineProperty(process, "platform", { value: "win32" });
        expect((await subject.run()).buffer.toString()).toBe("original");
        expect(subject.counts[boundary]).toBe(2);
        expect(subject.open).toHaveBeenCalledTimes(1);
        expect(subject.close).toHaveBeenCalledTimes(1);
      });
      it(`retains a known component across a Windows ${boundary} retry`, async () => {
        const subject = await fixture({ samples: {
          [boundary]: [{ dev: readIdentity.dev, ino: 0n }, { dev: readIdentity.dev + 1n }],
        } });
        Object.defineProperty(process, "platform", { value: "win32" });
        await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
        expect(subject.counts[boundary]).toBe(2);
        expect(subject.read).not.toHaveBeenCalled();
      });
      it(`propagates a Windows ${boundary} retry I/O error`, async () => {
        const failure = Object.assign(new Error("reinspection denied"), { code: "EACCES" });
        const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }, failure] } });
        Object.defineProperty(process, "platform", { value: "win32" });
        // Root adapters preserve the io/validation distinction in their result.
        if (route.startsWith("root")) {
          const params = { absolutePath: subject.filePath, rootPath: path.dirname(subject.filePath), boundaryLabel: "test" };
          const result = route === "root sync" ? openRootFileSync(params) : await openRootFile(params);
          expect(result).toMatchObject({ ok: false, reason: "io", error: failure });
        } else {
          await expect(subject.run()).rejects.toBe(failure);
        }
        expect(subject.counts[boundary]).toBe(2);
        expect(subject.read).not.toHaveBeenCalled();
        expect(subject.close).toHaveBeenCalledTimes(boundary === "preview" ? 0 : 1);
      });
      it(`rechecks file type on a Windows ${boundary} retry`, async () => {
        const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }, { kind: "symlink" }] } });
        Object.defineProperty(process, "platform", { value: "win32" });
        await expect(subject.run()).rejects.toThrow();
        expect(subject.read).not.toHaveBeenCalled();
        expect(subject.close).toHaveBeenCalledTimes(boundary === "preview" ? 0 : 1);
      });
      it(`rejects persistent unknown Windows ${boundary}`, async () => {
        const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }] } });
        Object.defineProperty(process, "platform", { value: "win32" });
        await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
        expect(subject.counts[boundary]).toBe(2);
        expect(subject.read).not.toHaveBeenCalled();
        expect(subject.close).toHaveBeenCalledTimes(boundary === "preview" ? 0 : 1);
      });
      it(`rejects an adapter returning numeric ${boundary} identity`, async () => {
        const subject = await fixture({ numericAdapter: boundary });
        await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
        expect(subject.read).not.toHaveBeenCalled();
      });
    }
  });
}
