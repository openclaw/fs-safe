import { spawnSync } from "node:child_process";
import { GUEST_FILESYSTEM_PYTHON } from "../../src/guest.js";

/** Fault injection runs inside the one-shot guest, without modifying its source. */
export function runGuest(args: string[], input?: Buffer | string, setup?: string) {
  const source = setup === undefined ? GUEST_FILESYSTEM_PYTHON : [
    "import base64, errno, os, sys",
    setup,
    `exec(compile(base64.b64decode('${Buffer.from(GUEST_FILESYSTEM_PYTHON).toString("base64")}'), '<fs-safe-guest>', 'exec'))`,
  ].join("\n");
  return spawnSync("python3", ["-c", source, ...args], {
    input,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
}
