import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/atomic-process-ownership.mjs", import.meta.url));
const actions = [
  "fd-zero-success", "fd-zero-refusal", "exit-staged", "exit-substituted",
  "exit-published", "exit-after-cleanup-failure",
] as const;

it.each(["async", "sync"].flatMap(flavor => actions.map(action => ({ flavor, action }))))(
  "retains atomic ownership across $action ($flavor)",
  async ({ flavor, action }) => {
    const directory = await tempRoot("fs-safe-atomic-process-");
    const target = path.join(directory, "target");
    await fs.writeFile(target, "original");
    const inheritedZero = process.platform === "win32" && action.startsWith("fd-zero-");
    let inheritedIdentity: { dev: string; ino: string } | undefined;
    const args = [fixture, directory, flavor, action];
    const options = { timeout: 15_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" as const };
    let output: { stdout: string; stderr: string };
    if (inheritedZero) {
      const seed = await fs.open(path.join(directory, "stdin-stage"), "wx+", 0o600);
      try {
        const identity = await seed.stat({ bigint: true });
        inheritedIdentity = { dev: String(identity.dev), ino: String(identity.ino) };
        const child = spawnSync(process.execPath, args, {
          ...options, encoding: "utf8", stdio: [seed.fd, "pipe", "pipe"],
        });
        expect(child.error, child.stderr).toBeUndefined();
        expect(child.signal, child.stderr).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        output = child;
      } finally {
        await seed.close();
      }
    } else {
      output = await exec(process.execPath, args, options);
    }
    const { stdout, stderr } = output;
    expect(stderr).toBe("");
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({ flavor, action });
    expect(receipt.stage).toMatch(/^\.fs-safe-replace\..+\.tmp$/u);
    const current = await fs.lstat(target, { bigint: true });
    const currentIdentity = { dev: String(current.dev), ino: String(current.ino) };
    const published = action === "fd-zero-success" || action === "exit-published";
    expect(await fs.readFile(target, "utf8")).toBe(published ? "replacement" : "original");
    expect(current.isFile()).toBe(true);
    if (published) expect(currentIdentity).not.toEqual(receipt.originalIdentity);
    else expect(currentIdentity).toEqual(receipt.originalIdentity);

    if (action.startsWith("fd-zero-")) {
      expect(receipt).toMatchObject({ stageFd: 0, stageCloses: 1 });
      expect(receipt.outcome).toBe(published ? "published" : "refused");
      if (inheritedZero) {
        expect(receipt).toMatchObject({
          descriptorSetup: "inherited-regular-file-adapter",
          descriptorState: "stdio-retained-until-process-exit",
          inheritedIdentity,
        });
        expect(receipt).not.toHaveProperty("descriptorClosed");
        expect(receipt.intermediateEntries).toEqual(receipt.setupSeedVisible
          ? ["stdin-stage", "target"] : ["target"]);
        if (published) expect(currentIdentity).toEqual(inheritedIdentity);
      } else {
        expect(receipt).toMatchObject({
          descriptorSetup: "builtin-open-after-stdin-close", descriptorClosed: true,
        });
      }
    }
    if (action === "exit-after-cleanup-failure") {
      expect(receipt).toMatchObject({ outcome: "refused", unlinkAttempts: 1, stageCloses: 1, descriptorClosed: true });
    }
    if (action === "exit-published") expect(currentIdentity).toEqual(receipt.publishedIdentity);
    if (action === "exit-substituted") {
      const stage = path.join(directory, receipt.stage);
      const substitute = await fs.lstat(stage, { bigint: true });
      const retained = await fs.lstat(path.join(directory, "retained"), { bigint: true });
      expect({ dev: String(substitute.dev), ino: String(substitute.ino) }).toEqual(receipt.substituteIdentity);
      expect({ dev: String(retained.dev), ino: String(retained.ino) }).toEqual(receipt.stageIdentity);
      expect(await fs.readFile(stage, "utf8")).toBe("substitute");
      expect(await fs.readFile(path.join(directory, "retained"), "utf8")).toBe("replacement");
      expect((await fs.readdir(directory)).sort()).toEqual([receipt.stage, "retained", "target"].sort());
    } else {
      expect(await fs.readdir(directory)).toEqual(["target"]);
    }
  },
  20_000,
);
