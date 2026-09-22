import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { FsSafeError } from "../src/errors.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const writers = [
  { operation: "write", write: writeSecretFileAtomic },
  { operation: "create", write: createSecretFileAtomic },
] as const;
type WriteParams = Parameters<typeof writeSecretFileAtomic>[0];
const fields = ["rootDir", "filePath", "content", "mode", "dirMode", "durable"] as const;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
});

function observedParams(values: WriteParams, observe: (field: typeof fields[number]) => void): WriteParams {
  const params = {} as WriteParams;
  for (const field of fields) {
    Object.defineProperty(params, field, { enumerable: true, get() {
      observe(field);
      return values[field];
    } });
  }
  return params;
}

function observeFilesystem() {
  return [
    vi.spyOn(fsSync, "lstatSync"), vi.spyOn(fsSync, "statSync"), vi.spyOn(fsSync.realpathSync, "native"),
    vi.spyOn(fsSync, "openSync"), vi.spyOn(fs, "open"), vi.spyOn(fs, "mkdir"),
  ];
}

for (const { operation, write } of writers) {
  it.each(fields.flatMap(field => [null, undefined].map(rejection => ({ field, rejection }))))(
    `${operation} preserves $field throwing $rejection before filesystem inspection`,
    async ({ field, rejection }) => {
      const directory = await tempRoot("fs-safe-secret-capture-rejected-");
      const rootDir = path.join(directory, "uncreated");
      const reads: string[] = [];
      const params = observedParams({ rootDir, filePath: path.join(rootDir, "token"), content: "synthetic" }, key => {
        reads.push(key);
        if (key === field) throw rejection;
      });
      const filesystem = observeFilesystem();
      const pending = write(params);
      expect(reads).toEqual(fields.slice(0, fields.indexOf(field) + 1));
      await expect(pending).rejects.toBe(rejection);
      for (const observation of filesystem) expect(observation).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );

  it(`${operation} captures every field once before yielding or inspecting the filesystem`, async () => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-secret-capture-order-");
    const filePath = path.join(rootDir, "nested", "token");
    const values: WriteParams = { rootDir, filePath, content: "original", mode: 0o600, dirMode: 0o700, durable: false };
    const reads: string[] = [];
    const filesystem = observeFilesystem();
    const params = observedParams(values, field => {
      reads.push(field);
      for (const observation of filesystem) expect(observation).not.toHaveBeenCalled();
    });
    const pending = write(params);
    expect(reads).toEqual(fields);
    Object.assign(values, {
      rootDir: path.join(rootDir, "other"), filePath: path.join(rootDir, "other", "decoy"),
      content: "changed", mode: 0o777, dirMode: 0o777, durable: true,
    });
    await pending;
    expect(reads).toEqual(fields);
    expect(await fs.readFile(filePath, "utf8")).toBe("original");
    expect(await fs.readdir(rootDir)).toEqual(["nested"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    }
  }, process.platform === "win32" ? 120_000 : undefined);

  it.each(["root", "file", "file-getter"] as const)(
    `${operation} preserves Windows alias precedence for %s`,
    async failure => {
      const directory = await tempRoot("fs-safe-secret-capture-alias-");
      const reads: string[] = [];
      const sentinel = new Error("file path getter refused");
      const params = observedParams({
        rootDir: failure === "file" ? directory : `${directory}:root`,
        filePath: `${path.join(directory, "token")}:stream`, content: "unwritten",
      }, field => {
        reads.push(field);
        if (field === "filePath" && failure === "file-getter") throw sentinel;
      });
      const filesystem = observeFilesystem();
      // Exercise only Windows alias admission; no Windows filesystem operation is simulated.
      Object.defineProperty(process, "platform", { value: "win32" });
      const pending = write(params);
      expect(reads).toEqual(["rootDir", "filePath"]);
      if (failure === "file-getter") await expect(pending).rejects.toBe(sentinel);
      else await expect(pending).rejects.toMatchObject({
        code: "invalid-path", details: { reason: "windows-path-alias" },
        message: `private secret ${failure === "root" ? "root" : "path"} uses a Windows filesystem namespace alias`,
      });
      for (const observation of filesystem) expect(observation).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
}

it.each([
  Object.assign(new Error("existing entry"), { code: "EEXIST" }),
  new FsSafeError("already-exists", "existing entry"),
])("retains create-only collision mapping for a getter failure with $code", async rejection => {
  const directory = await tempRoot("fs-safe-secret-capture-collision-");
  const params = {
    rootDir: directory, filePath: path.join(directory, "token"),
    get content(): string { throw rejection; },
  };
  await expect(writeSecretFileAtomic(params)).rejects.toBe(rejection);
  await expect(createSecretFileAtomic(params)).rejects.toMatchObject({ code: "secret-exists", cause: rejection });
  expect(await fs.readdir(directory)).toEqual([]);
});
