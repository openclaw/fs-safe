import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Read only: importing this standalone proof would launch its worker suite.
const source = fs.readFileSync(new URL("../scripts/sidecar-contention-proof.mjs", import.meta.url), "utf8")
  .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, "");

function functionSource(name: string): string {
  const match = source.match(new RegExp(
    `^(?:async\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?(?=^(?:async\\s+)?function\\s|^try\\s*\\{)`,
    "mu",
  ));
  expect(match, `missing proof function ${name}`).not.toBeNull();
  return match![0];
}

describe("sidecar contention proof contract", () => {
  it("keeps a finite default and unlimited retries with the same backoff and jitter", () => {
    const options = source.match(
      /const\s+lockOptions\s*=\s*\(\s*timeoutMs\s*=\s*15_?000\s*\)\s*=>\s*\(\s*\{(?<body>[\s\S]*?)\}\s*\)\s*;/u,
    )?.groups?.body;
    expect(options).toBeDefined();
    expect(options).toMatch(/(?:^|,)\s*timeoutMs\s*,/u);
    expect(options).not.toMatch(/\btimeoutMs\s*:/u);
    const retry = options?.match(/\bretry\s*:\s*\{(?<body>[^}]+)\}/u)?.groups?.body;
    expect(retry?.split(",").map((entry) => entry.replace(/\s/gu, "")).filter(Boolean).sort()).toEqual([
      "factor:1", "maxTimeout:5", "minTimeout:1", "randomize:true",
    ]);
    expect(options).not.toMatch(/\bretries\b/u);
    expect(options).toMatch(/\bstaleRecovery\s*:\s*["']fail-closed["']/u);
  });

  it("gives both child acquisition APIs only the unbounded contention options", () => {
    const worker = functionSource("runWorker");
    expect(worker).toMatch(
      /const\s+options\s*=\s*\{\s*\.\.\.lockOptions\s*\(\s*Infinity\s*\)\s*,\s*lockRoot\s*,?\s*\}\s*;/u,
    );
    expect([...worker.matchAll(/\bacquireFileLock(?:Sync)?\s*\([^)]*\)/gu)].map(([call]) =>
      call.replace(/\s/gu, ""))).toEqual([
      "acquireFileLockSync(target,options)", "acquireFileLock(target,options)",
    ]);
    // Catch overrides/mutations as well as changing the helper's Infinity argument.
    expect(worker.match(/\boptions\b/gu)).toHaveLength(3);
    expect(worker).not.toMatch(/\b(?:timeoutMs|retry|retries)\b/u);
    expect(worker.match(/\blockOptions\s*\(/gu)).toHaveLength(1);
  });

  it("keeps both parent permission acquisitions on the finite default", () => {
    const permission = functionSource("runPermissionCase");
    expect(permission.match(/\bacquireFileLockSync\s*\(\s*target\s*,\s*lockOptions\s*\(\s*\)\s*\)/gu))
      .toHaveLength(2);
    expect(permission.match(/\bacquireFileLock(?:Sync)?\s*\(/gu)).toHaveLength(2);
    expect(permission).not.toMatch(/\bInfinity\b/u);
    expect(source.match(/\blockOptions\s*\(/gu)).toHaveLength(3);
  });

  it("preserves all four cases and the four-by-25 workload with 2ms critical sections", () => {
    expect(source).toMatch(/const\s+processes\s*=\s*4\s*;/u);
    expect(source).toMatch(/const\s+acquisitionsPerProcess\s*=\s*25\s*;/u);
    expect([...source.matchAll(/name:\s*["']((?:pathname|root)-(?:async|sync))["']/gu)]
      .map((match) => match[1])).toEqual(["pathname-async", "pathname-sync", "root-async", "root-sync"]);
    const worker = functionSource("runWorker");
    expect(worker).toMatch(/index\s*<\s*acquisitionsPerProcess/u);
    expect(worker).toMatch(/Atomics\.wait\s*\(\s*waitWord\s*,\s*0\s*,\s*0\s*,\s*2\s*\)/u);
    expect(worker).toMatch(/await\s+pause\s*\(\s*2\s*\)/u);
    expect(functionSource("runContentionCase")).toMatch(/index\s*<\s*processes/u);
  });

  it("keeps the parent's 60-second watchdog wired to kill and reap workers", () => {
    expect(source).toMatch(/const\s+childDeadlineMs\s*=\s*60_?000\s*;/u);
    const launch = functionSource("launchWorker");
    expect(launch).toMatch(
      /const\s+deadline\s*=\s*setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{\s*timedOut\s*=\s*true\s*;\s*stop\s*\(\s*\)\s*;\s*\}\s*,\s*childDeadlineMs\s*\)/u,
    );
    expect(launch).toMatch(/const\s+stop\s*=\s*\(\s*\)\s*=>\s*\{\s*if\s*\(\s*!closed\s*\)\s*\{\s*try\s*\{\s*child\.kill\s*\(\s*["']SIGKILL["']\s*\)/u);
    expect(launch).toMatch(/const\s+done\s*=\s*new\s+Promise\s*\(\s*\(\s*resolve\s*\)\s*=>\s*\{\s*child\.once\s*\(\s*["']close["']/u);
    expect(launch).toMatch(/child\.once\s*\(\s*["']close["']\s*,\s*\(\s*exitCode\s*,\s*signal\s*\)\s*=>\s*\{\s*closed\s*=\s*true\s*;\s*clearTimeout\s*\(\s*deadline\s*\)/u);
    expect(launch).toMatch(/const\s+passed\s*=\s*exitCode\s*===\s*0\s*&&\s*!signal\s*&&\s*!timedOut/u);
    expect(launch).toMatch(/return\s*\{\s*ready\s*,\s*released\s*,\s*done\s*,\s*stop\s*,/u);
    expect(functionSource("runContentionCase")).toMatch(
      /finally\s*\{\s*for\s*\(\s*const\s+child\s+of\s+children\s*\)\s*child\.stop\s*\(\s*\)\s*;\s*const\s+settled\s*=\s*await\s+Promise\.allSettled\s*\(\s*children\.map\s*\(\s*\(\s*child\s*\)\s*=>\s*child\.done\s*\)\s*\)/u,
    );
  });
});
