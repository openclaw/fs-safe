import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let directory: string;
let addon: string;
beforeEach(async () => {
  directory = await tempRoot("fs-safe-darwin-signing-");
  addon = path.join(directory, "addon.node");
  await fs.writeFile(addon, "synthetic addon");
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const root = process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(root, 'calls'), command + ':' + args[0] + '\\n');
if (command === 'codesign' && args[0] === '-dv') {
  console.error('Authority=Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)');
  console.error('TeamIdentifier=' + (process.env.WRONG_TEAM ? 'WRONG' : 'FWJYW4S8P8'));
  console.error('CodeDirectory v=20500 flags=' + (process.env.AD_HOC ? '0x2(adhoc)' : '0x10000(runtime)'));
  if (!process.env.NO_TIMESTAMP) console.error('Timestamp=Oct 21, 2026');
  if (process.env.LARGE_DETAILS) console.error('AdditionalDetails=' + 'x'.repeat(256 * 1024));
}
if (command === 'ditto') fs.writeFileSync(args.at(-1), 'synthetic ZIP');
if (command === 'xcrun' && args[1] === 'submit') {
  fs.writeFileSync(path.join(root, 'archive-hash'), crypto.createHash('sha256').update(fs.readFileSync(args[2])).digest('hex'));
  console.log(JSON.stringify({ id:'12345678-1234-1234-1234-123456789abc', status: process.env.REJECTED ? 'Invalid' : 'Accepted' }));
}
if (command === 'xcrun' && args[1] === 'log') {
  fs.writeFileSync(args.at(-1), JSON.stringify({jobId:'12345678-1234-1234-1234-123456789abc', status:'Accepted', statusCode:0, sha256:process.env.WRONG_HASH ? 'wrong' : fs.readFileSync(path.join(root, 'archive-hash'), 'utf8')}));
}
`;
  for (const name of ["codesign", "security", "ditto", "xcrun"]) {
    await fs.writeFile(path.join(directory, name), mock, { mode: 0o700 });
  }
});

function run(extra: Record<string, string> = {}) {
  return spawnSync("bash", ["scripts/sign-darwin-addon.sh", addon], {
    encoding: "utf8",
    env: {
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: directory, FIXTURE_ROOT: directory,
      MACOS_SIGNING_P12: Buffer.from("synthetic certificate").toString("base64"),
      MACOS_SIGNING_P12_PASSWORD: "synthetic password", ASC_KEY_ID: "SYNTHETIC1",
      ASC_ISSUER_ID: "synthetic issuer", ASC_PRIVATE_KEY_P8: "synthetic private key",
      ...extra,
    },
  });
}

describe.skipIf(process.platform === "win32")("Darwin release signing", () => {
  it("retains Apple acceptance tied to the addon bytes and cleans credentials", async () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(await fs.readFile(addon.replace(".node", ".notarization.json"), "utf8"));
    expect(proof.status).toBe("Accepted");
    expect(proof.teamIdentifier).toBe("FWJYW4S8P8");
    expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.readdir(directory)).filter(name => name.startsWith("fs-safe-sign."))).toEqual([]);
    expect(await fs.readFile(path.join(directory, "calls"), "utf8")).toContain("security:delete-keychain");
  }, 30_000);

  it("drains verbose signing details without a pipefail SIGPIPE", () => {
    const result = run({ LARGE_DETAILS: "1" });
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it.each(["WRONG_TEAM", "AD_HOC", "NO_TIMESTAMP", "REJECTED", "WRONG_HASH"])("refuses %s and cleans credentials", async (failure) => {
    const result = run({ [failure]: "1" });
    expect(result.status).not.toBe(0);
    await expect(fs.stat(addon.replace(".node", ".notarization.json"))).rejects.toThrow();
    expect((await fs.readdir(directory)).filter(name => name.startsWith("fs-safe-sign."))).toEqual([]);
    expect(await fs.readFile(path.join(directory, "calls"), "utf8")).toContain("security:delete-keychain");
  }, 30_000);

  it("refuses missing credentials before invoking signing tools", async () => {
    expect(run({ MACOS_SIGNING_P12: "" }).status).not.toBe(0);
    await expect(fs.stat(path.join(directory, "calls"))).rejects.toThrow();
  });
});
