import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const fixture = fileURLToPath(new URL("./fixtures/sidecar-lock-publication-child.mjs", import.meta.url));
for (const mode of ["auto", "off"]) {
  it.each(["raw-async", "raw-sync", "root-async", "root-sync"])(`%s survives a killed staging writer (${mode})`, async kind => {
    const directory = await tempRoot("fs-safe-crash-");
    const child = spawn(process.execPath, [fixture, directory, kind, mode], {
      env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    try {
      const publication = await new Promise<{ final: string; temporary: string; pid: number }>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", data => {
          output += data;
          if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
        });
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`child exited ${code}: ${stderr}`)));
      });
      expect(publication.pid).toBe(child.pid);
      await expect(fs.stat(publication.final)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(publication.temporary, "utf8").then(JSON.parse)).toMatchObject({ owner: "child" });
      // Suspended live staging is not cleanup authority. Another contender can
      // own the final name; the eventual publish still must not replace it.
      const first = await acquireFileLock(path.join(directory, "state"), {
        managerKey: `live-${directory}`, payload: () => ({ owner: "first" }), timeoutMs: 0,
      });
      expect(await fs.stat(publication.temporary)).toBeTruthy();
      await first.release();
      child.kill("SIGKILL");
      await exited;
      const second = await acquireFileLock(path.join(directory, "state"), {
        managerKey: `dead-${directory}`, payload: () => ({ owner: "second" }), timeoutMs: 0,
      });
      try {
        expect(await fs.readdir(directory)).toEqual(["state.lock"]);
        expect(JSON.parse(await fs.readFile(publication.final, "utf8"))).toEqual({ owner: "second" });
      } finally { await second.release(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}

it.each(["raw-async", "raw-sync", "root-async", "root-sync"])("%s recovers a killed publisher after the final hardlink exists", async kind => {
  const directory = await tempRoot("fs-safe-linked-crash-");
  const child = spawn(process.execPath, [fixture, directory, kind, "off", "linked"], {
    env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const publication = await new Promise<{ final: string; temporary: string; pid: number }>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", data => {
        output += data;
        if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`child exited ${code}: ${stderr}`)));
    });
    expect(publication.pid).toBe(child.pid);
    expect((await fs.stat(publication.final)).nlink).toBe(2);
    expect(JSON.parse(await fs.readFile(publication.final, "utf8"))).toEqual({ pid: child.pid, owner: "child" });
    child.kill("SIGKILL");
    await exited;
    const options = {
      payload: () => ({ owner: "recovered" }), staleMs: 0, shouldReclaim: () => true, shouldRemoveStaleLock: () => true,
      staleRecovery: "remove-if-unchanged" as const, timeoutMs: Infinity,
      retry: { retries: 2, minTimeout: 0, maxTimeout: 0 },
      ...(kind.startsWith("root") ? { lockRoot: await root(directory) } : {}),
    };
    const target = path.join(directory, "state");
    const owner = kind.endsWith("async") ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
    try {
      expect(await fs.readdir(directory)).toEqual(["state.lock"]);
      expect(JSON.parse(await fs.readFile(publication.final, "utf8"))).toEqual({ owner: "recovered" });
    } finally { await owner.release(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
