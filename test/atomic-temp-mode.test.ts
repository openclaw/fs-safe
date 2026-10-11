import fs from "node:fs";
import promises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

for (const fixture of [
  { label: "already correct", mode: 0o600, mask: 0o077, calls: 0 },
  { label: "umask correction", mode: 0o640, mask: 0o077, calls: 1 },
  { label: "fully masked", mode: 0o600, mask: 0o777, calls: 1 },
  { label: "special bits correction", mode: 0o600, mask: 0o077, altered: 0o4600, calls: 1 },
]) {
  itPosix(`applies the exact staged mode: ${fixture.label}`, async () => {
    const directory = await tempRoot("fs-safe-atomic-mode-");
    fs.chmodSync(directory, 0o700);
    const filePath = path.join(directory, "value");
    const open = promises.open;
    const writeFile = promises.writeFile;
    let tempFd: number | undefined;
    let chmodCalls = 0;
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        tempFd = handle.fd;
        const chmod = handle.chmod.bind(handle);
        handle.chmod = async (mode) => { chmodCalls += 1; await chmod(mode); };
      }
      return handle;
    });
    vi.spyOn(promises, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      if (fixture.altered !== undefined) fs.fchmodSync(tempFd!, fixture.altered);
    });
    const previousMask = process.umask(fixture.mask);
    try {
      await replaceFileAtomic({ filePath, content: "complete", mode: fixture.mode });
    } finally { process.umask(previousMask); }
    expect(chmodCalls).toBe(fixture.calls);
    expect(fs.statSync(filePath).mode & 0o7777).toBe(fixture.mode);
    expect(fs.readFileSync(filePath, "utf8")).toBe("complete");
    expect(fs.readdirSync(directory)).toEqual(["value"]);
  });
}

itPosix("avoids a redundant synchronous mode mutation but corrects a restrictive umask", async () => {
  const directory = await tempRoot("fs-safe-atomic-sync-mode-");
  const filePath = path.join(directory, "value");
  const chmod = vi.spyOn(fs, "fchmodSync");
  const previousMask = process.umask(0o077);
  try {
    replaceFileAtomicSync({ filePath, content: "first", mode: 0o600 });
    expect(chmod.mock.calls.filter(([, mode]) => mode === 0o600)).toHaveLength(0);
    process.umask(0o777);
    replaceFileAtomicSync({ filePath, content: "second", mode: 0o600 });
    expect(chmod.mock.calls.filter(([, mode]) => mode === 0o600)).toHaveLength(1);
  } finally { process.umask(previousMask); }
  expect(fs.statSync(filePath).mode & 0o7777).toBe(0o600);
  expect(fs.readFileSync(filePath, "utf8")).toBe("second");
});
