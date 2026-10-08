import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGuest } from "./helpers/guest-filesystem.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe.skipIf(process.platform === "win32")("guest cross-device file mode", () => {
  it("preserves the admitted descriptor mode when it changes after pathname inspection", async () => {
    const root = await tempRoot("fs-safe-guest-move-mode-");
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await fs.writeFile(source, "private payload", { mode: 0o644 });
    await fs.chmod(source, 0o644);
    const result = runGuest(["rename", root, "", "source", root, "", "target", "0"], undefined, [
      "def cross_device(*args, **kwargs):",
      "    raise OSError(errno.EXDEV, 'simulated cross-device rename')",
      "os.rename = cross_device",
      "original_open = os.open",
      "def change_mode_before_open(name, flags, *args, **kwargs):",
      "    if name == 'source' and kwargs.get('dir_fd') is not None:",
      "        os.chmod(name, 0o600, dir_fd=kwargs['dir_fd'])",
      "    return original_open(name, flags, *args, **kwargs)",
      "os.open = change_mode_before_open",
    ].join("\n"));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(await fs.readFile(target, "utf8")).toBe("private payload");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(root)).toEqual(["target"]);
  });
});
