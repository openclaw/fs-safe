import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { sidecarStagingPath } from "../src/sidecar-lock-staging.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

for (const mode of ["auto", "off"] as const) {
  it.each(["async", "sync"].flatMap(kind => [false, true].map(linked => ({ kind, linked }))))(
    `Root $kind protects denied abandoned stages (linked=$linked, native=${mode})`, async ({ kind, linked }) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-stage-policy-");
      const target = path.join(directory, "state"), final = `${target}.lock`;
      const stage = sidecarStagingPath(final), bytes = '{"owner":"abandoned"}';
      fs.writeFileSync(stage, bytes);
      if (linked) fs.linkSync(stage, final);
      const capability = await root(directory, { denyMutations: { paths: [stage] } });
      vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
      const options = {
        lockRoot: capability, payload: () => ({ owner: "new" }),
        retry: { retries: 0 }, timeoutMs: 0,
      };
      const acquire = async () => kind === "async" ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
      await expect(acquire()).rejects.toMatchObject({ code: "denied-path" });
      expect(fs.readFileSync(stage, "utf8")).toBe(bytes);
      expect(fs.statSync(stage).nlink).toBe(linked ? 2 : 1);
      expect(fs.existsSync(final)).toBe(linked);
    },
  );
}
