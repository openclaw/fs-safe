import sync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const operationFailure = Object.assign(new Error("parent preparation EIO"), { code: "EIO" });
const closeFailure = Object.assign(new Error("parent close EPERM"), { code: "EPERM" });

describe.skipIf(process.platform === "win32")("atomic parent failure precedence", () => {
  it.each(["async", "sync"] as const)("retains %s preparation and close failures in order", async mode => {
    for (const stage of ["stat", "chmod"] as const) for (const primary of [operationFailure, undefined, false]) {
      const directory = await tempRoot("atomic-parent-errors-");
      const filePath = path.join(directory, "target");
      await fs.chmod(directory, 0o755);
      await fs.writeFile(filePath, "original");
      let closes = 0, captured: { error: unknown } | undefined;
      try {
        if (mode === "async") {
          await replaceFileAtomic({ filePath, content: "replacement", dirMode: 0o700,
            fileSystem: { promises: { ...fs, open: async (...args) => {
              const handle = await fs.open(...args);
              const close = handle.close.bind(handle);
              if (stage === "stat") handle.stat = async () => { throw primary; };
              else handle.chmod = async () => { throw primary; };
              handle.close = async () => { closes++; await close(); throw closeFailure; };
              return handle;
            } } },
          });
        } else {
          replaceFileAtomicSync({ filePath, content: "replacement", dirMode: 0o700,
            fileSystem: { ...sync,
              ...(stage === "stat" ? { fstatSync: () => { throw primary; } } : { fchmodSync: () => { throw primary; } }),
              closeSync: fd => { closes++; sync.closeSync(fd); throw closeFailure; },
            },
          });
        }
      } catch (error) { captured = { error }; }
      expect(captured?.error, `${mode} ${stage}`).toBeInstanceOf(AggregateError);
      expect((captured!.error as AggregateError).errors).toEqual([primary, closeFailure]);
      expect(closes).toBe(1);
      expect(await fs.readFile(filePath, "utf8")).toBe("original");
      expect(await fs.readdir(directory)).toEqual(["target"]);
    }
  });
});
