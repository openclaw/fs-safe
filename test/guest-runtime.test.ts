import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.skipIf(process.platform === "win32")("guest runtime dependencies", () => {
  it.each(["write", "create", "copy", "cross-device directory move"])(
    "%s works without Python cryptographic modules",
    async (operation) => {
      const root = await tempRoot("fs-safe-guest-runtime-");
      const directory = operation === "cross-device directory move";
      if (directory) await fs.mkdir(path.join(root, "source"));
      const source = path.join(root, "source", ...(directory ? ["payload"] : []));
      await fs.writeFile(source, "payload");
      const setup = [
        // The filesystem protocol needs OS randomness, not hashing or TLS.
        "for module in ('hmac', 'hashlib', '_hashlib', 'ssl', '_ssl'):",
        "    sys.modules[module] = None",
        ...(directory ? [
          "original_rename = os.rename",
          "def cross_device(src, dst, **kwargs):",
          "    if src == 'source':",
          "        raise OSError(errno.EXDEV, 'simulated cross-device rename')",
          "    return original_rename(src, dst, **kwargs)",
          "os.rename = cross_device",
        ] : []),
      ].join("\n");
      const args = operation === "write" || operation === "create"
        ? [operation, root, "", "target", "0"]
        : [directory ? "rename" : "copy", root, "", "source", root, "", "target", "0"];
      const result = runGuest(args, "payload", setup);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(await fs.readFile(path.join(root, "target", ...(directory ? ["payload"] : [])), "utf8"))
        .toBe("payload");
      expect((await fs.readdir(root)).sort()).toEqual(directory ? ["target"] : ["source", "target"]);
    },
  );
});
