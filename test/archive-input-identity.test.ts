import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { observeReadAdmission, readIdentity, type ReadBoundary } from "./helpers/read-admission-identity.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetFsSafeNativeConfigForTest();
});

describe.each(["read", "extract"] as const)("archive %s input identity", (route) => {
  async function fixture(options: Parameters<typeof observeReadAdmission>[1] = {}) {
    const directory = await fs.realpath(await tempRoot("fs-safe-archive-identity-"));
    const filePath = path.join(directory, "input.zip");
    const destination = path.join(directory, "output");
    await fs.mkdir(destination);
    for (const [target, value] of [[filePath, "original"], [`${filePath}.replacement`, "replacement"]]) {
      await fs.writeFile(target!, await new JSZip().file("value", value!).generateAsync({ type: "nodebuffer" }));
    }
    const observed = observeReadAdmission(filePath, options);
    return {
      ...observed, destination,
      run: () => route === "read"
        ? readArchiveEntry(filePath, "value", { maxBytes: 100 })
        : extractArchive({ archivePath: filePath, destDir: destination }),
    };
  }

  it.each(["before-open", "after-open"] as const)("rejects a rounded-equal source swap %s", async (swap) => {
    const subject = await fixture({ swap });
    await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(subject.read).not.toHaveBeenCalled();
    expect(subject.close).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(subject.destination)).toEqual([]);
  });

  for (const boundary of ["preview", "descriptor", "current"] as ReadBoundary[]) {
    it(`retries transient unknown Windows ${boundary} without reopening`, async () => {
      const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }, {}] } });
      Object.defineProperty(process, "platform", { value: "win32" });
      await subject.run();
      expect(subject.counts[boundary]).toBe(2);
      expect(subject.open).toHaveBeenCalledTimes(1);
      expect(subject.close).toHaveBeenCalledTimes(1);
    });
    it(`rejects conflicting known bits during Windows ${boundary} retry`, async () => {
      const subject = await fixture({ samples: {
        [boundary]: [{ ino: 0n }, { dev: readIdentity.dev + 1n }],
      } });
      Object.defineProperty(process, "platform", { value: "win32" });
      await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(subject.read).not.toHaveBeenCalled();
      expect(subject.close).toHaveBeenCalledTimes(boundary === "preview" ? 0 : 1);
    });
    it(`rejects persistent unknown Windows ${boundary}`, async () => {
      const subject = await fixture({ samples: { [boundary]: [{ ino: 0n }] } });
      Object.defineProperty(process, "platform", { value: "win32" });
      await expect(subject.run()).rejects.toMatchObject({ code: "path-mismatch" });
      expect(subject.read).not.toHaveBeenCalled();
      expect(subject.close).toHaveBeenCalledTimes(boundary === "preview" ? 0 : 1);
      expect(await fs.readdir(subject.destination)).toEqual([]);
    });
  }
});
