import syncFs, { type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";

type AsyncTempFileSystem = Pick<typeof fs, "open" | "writeFile">;
type SyncTempFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "fsyncSync" | "openSync" | "writeFileSync"
>;

export type SyncFchmod = (fd: number, mode: number) => void;

export async function writeTempFile(params: {
  fsModule: AsyncTempFileSystem;
  tempPath: string;
  content: string | Uint8Array;
  mode: number;
  sync: boolean;
}): Promise<Stats> {
  const handle = await params.fsModule.open(params.tempPath, "wx", params.mode);
  try {
    await params.fsModule.writeFile(handle, params.content);
    await handle.chmod(params.mode);
    if (params.sync) {
      try {
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
    }
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

export function writeTempFileSync(params: {
  fsModule: SyncTempFileSystem;
  tempPath: string;
  content: string | Uint8Array;
  mode: number;
  fchmodSync?: SyncFchmod;
  sync: boolean;
}): Stats {
  const fd = params.fsModule.openSync(params.tempPath, "wx", params.mode);
  try {
    params.fsModule.writeFileSync(fd, params.content);
    params.fchmodSync?.(fd, params.mode);
    if (params.sync) {
      try {
        params.fsModule.fsyncSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
    }
    return params.fsModule.fstatSync(fd);
  } finally {
    params.fsModule.closeSync(fd);
  }
}
