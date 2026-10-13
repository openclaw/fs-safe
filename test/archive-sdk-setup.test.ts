import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { checkSdk } from "../.github/actions/setup-windows-helper/check.mjs";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

it("resolves archive setup dependencies when the reviewed checkout is under harness/", async () => {
  const workspace = await tempRoot("fs-safe-relocated-action-");
  const checkout = path.join(workspace, "harness");
  await mkdir(path.join(checkout, ".github"), { recursive: true });
  await cp(".github/actions", path.join(checkout, ".github/actions"), { recursive: true });
  const visit = async (action: string): Promise<void> => {
    const text = await readFile(path.join(action, "action.yml"), "utf8");
    expect(text).toMatch(/^runs:/mu);
    for (const [, dependency] of text.matchAll(/uses:\s+(\.\/[^\s]+)/gu)) {
      const target = path.join(workspace, dependency!);
      // GitHub resolves nested local actions from GITHUB_WORKSPACE, not the
      // enclosing composite action's checkout or directory.
      expect((await stat(path.join(target, "action.yml"))).isFile()).toBe(true);
      await visit(target);
    }
  };
  await visit(path.join(checkout, ".github/actions/setup-archive-llvm"));
});

it("checks the SDK in its checkout and requests installation for an absent or different SDK", async () => {
  const checkout = await tempRoot("fs-safe-sdk-pin-");
  await writeFile(path.join(checkout, "global.json"), JSON.stringify({ sdk: { version: "8.0.425" } }));
  const result = checkSdk(checkout, (command, args, options) => {
    expect(command).toBe("dotnet");
    expect(args).toEqual(["--version"]);
    expect(options.cwd).toBe(checkout);
    return { status: 0, stdout: "8.0.425\n" };
  });
  expect(result).toEqual({ available: true, installed: true, sdkFile: path.join(checkout, "global.json") });
  expect(checkSdk(checkout, () => ({ status: 0, stdout: "9.0.100\n" })).installed).toBe(false);
  expect(checkSdk(checkout, () => ({ status: null, stdout: null })).installed).toBe(false);
  expect(checkSdk(path.join(checkout, "absent"))).toEqual({ available: false });
});

it.skipIf(process.platform === "win32")("exports the relocated pin when the caller workspace has a different global.json", async () => {
  const workspace = await tempRoot("fs-safe-sdk-caller-");
  const checkout = path.join(workspace, "harness");
  const action = path.join(checkout, ".github/actions/setup-windows-helper");
  await mkdir(action, { recursive: true });
  await cp(".github/actions/setup-windows-helper/check.mjs", path.join(action, "check.mjs"));
  await writeFile(path.join(workspace, "global.json"), JSON.stringify({ sdk: { version: "9.0.100" } }));
  await writeFile(path.join(checkout, "global.json"), JSON.stringify({ sdk: { version: "8.0.425" } }));
  await writeFile(path.join(workspace, "dotnet"), "#!/bin/sh\nprintf '8.0.425\\n'\n", { mode: 0o700 });
  const output = path.join(workspace, "output");
  execFileSync(process.execPath, [path.join(action, "check.mjs")], {
    cwd: workspace, env: { ...process.env, PATH: workspace, GITHUB_OUTPUT: output },
  });
  expect(await readFile(output, "utf8")).toBe(
    `available=true\ninstalled=true\nsdk_file=${path.join(checkout, "global.json")}\n`,
  );
});
