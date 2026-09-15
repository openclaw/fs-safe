import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { useRealTempDirs } from "./vitest.js";

export function useFileHandleTransferFixture() {
  const { tempRoot } = useRealTempDirs();
  const handles: FileHandle[] = [];

  // Register after temporary-directory cleanup so Vitest's reverse hook order
  // restores mocks and closes borrowed handles before removing their files.
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(handles.splice(0).map(handle => handle.close()));
  });

  function trackHandle<Handle extends FileHandle>(handle: Handle): Handle {
    handles.push(handle);
    return handle;
  }

  async function fixture(
    content: string | Buffer = "source bytes",
    prior = "original target with a tail",
  ) {
    const directory = await tempRoot("fs-safe-handle-transfer-");
    const sourcePath = path.join(directory, "source");
    const targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, content, { mode: 0o600 });
    await fs.writeFile(targetPath, prior, { mode: 0o640 });
    const source = trackHandle(await fs.open(sourcePath, "r"));
    const target = trackHandle(await fs.open(targetPath, "r+"));
    return { source, target, sourcePath, targetPath, content: Buffer.from(content), prior };
  }

  return { fixture, trackHandle };
}
