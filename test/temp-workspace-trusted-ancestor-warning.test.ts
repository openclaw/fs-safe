import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let api: typeof import("../src/temp.js");

beforeEach(async () => {
  vi.resetModules();
  const { configureFsSafeNative } = await import("../src/native-config.js");
  configureFsSafeNative({ mode: "off" });
  api = await import("../src/temp.js");
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("trusted ancestor warnings", () => {
  async function fixture(mode = 0o777) {
    const ancestor = await tempRoot("fs-safe-trusted-warning-");
    const rootDir = path.join(ancestor, "private");
    await fs.mkdir(rootDir, { mode: 0o700 });
    await fs.chmod(ancestor, mode);
    return { ancestor, rootDir };
  }

  it("warns once across async/sync workspaces and different trusted ancestors without paths", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    for (const sync of [false, true]) {
      const { ancestor, rootDir } = await fixture();
      const options = { rootDir, prefix: "warning-", trustedWritableAncestors: [ancestor] };
      const workspace = sync ? api.tempWorkspaceSync(options) : await api.tempWorkspace(options);
      await workspace.writeText("result", "private");
      expect(await workspace.cleanup()).toBe("removed");
    }
    expect(warning.mock.calls).toEqual([[
      "Temp workspace ancestor write protection is bypassed by trustedWritableAncestors; external isolation must prevent untrusted writers, including same-UID processes, from replacing the directory ancestry for the workspace lifetime.",
      { code: "FS_SAFE_TRUSTED_WRITABLE_ANCESTOR", type: "FsSafeWarning" },
    ]]);
  });

  it.each([0o700, 0o1777])("does not warn for an already accepted ancestor at mode %o", async (mode) => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { ancestor, rootDir } = await fixture(mode);
    const options = { rootDir, prefix: "warning-", trustedWritableAncestors: [ancestor, rootDir] };
    await api.withTempWorkspace(options, async () => {});
    api.withTempWorkspaceSync(options, () => {});
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not warn for omitted, empty, or irrelevant policies and keeps rejecting the ancestor", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { ancestor, rootDir } = await fixture();
    for (const trustedWritableAncestors of [undefined, [], [path.dirname(ancestor)]]) {
      const options = { rootDir, prefix: "warning-", trustedWritableAncestors };
      await expect(api.tempWorkspace(options)).rejects.toMatchObject({ code: "insecure-permissions" });
      expect(() => api.tempWorkspaceSync(options)).toThrowError(expect.objectContaining({ code: "insecure-permissions" }));
    }
    expect(warning).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});
