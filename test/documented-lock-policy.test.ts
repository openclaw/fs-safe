import { describe, expect, it, vi } from "vitest";
import { readRepoFile } from "../scripts/documented-imports.mjs";

async function documentedPolicy(kill: (pid: number, signal: number) => void) {
  const markdown = readRepoFile("docs/sidecar-lock.md");
  const section = markdown.split("## Stale policy: `shouldReclaim`")[1];
  const example = section?.match(/```ts\n([\s\S]*?)```/u)?.[1];
  if (!example) throw new Error("missing stale-lock policy example");
  let policy!: (params: { payload: unknown }) => boolean;
  // Execute the documented callback with synthetic acquisition and process probes.
  const run = new Function("acquireFileLock", "kill", "targetPath", `
    return (async () => { ${example.replace(/^import .*;\n/gmu, "")} })();
  `);
  await run(
    (_target: string, options: { shouldReclaim: typeof policy }) => {
      policy = options.shouldReclaim;
      return Promise.resolve({});
    },
    kill,
    "/synthetic/state.json",
  );
  return policy;
}

describe("documented stale-lock policy", () => {
  it.each([null, true, "payload", {}, { pid: 0 }, { pid: -1 }, { pid: "123" }])(
    "does not probe malformed or nonpositive process ids: %j", async payload => {
      const kill = vi.fn();
      const policy = await documentedPolicy(kill);
      expect(policy({ payload })).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "EPERM", "EIO", "ESRCH"])(
    "marks a process stale only for ESRCH (probe outcome %s)", async code => {
      const kill = vi.fn(() => {
        if (code) throw Object.assign(new Error("synthetic process probe"), { code });
      });
      const policy = await documentedPolicy(kill);
      expect(policy({ payload: { pid: 123 } })).toBe(code === "ESRCH");
      expect(kill).toHaveBeenCalledWith(123, 0);
    },
  );
});
