import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { decodeCreationAclBatch, encodeCreationAclBatch } from "../scripts/consumer-creation-contract.mjs";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useTempDirs } from "./helpers/vitest.js";
import { runWindowsSecurityScript } from "./helpers/windows-security-script.js";

const { tempRoot } = useTempDirs();
const script = fileURLToPath(new URL("../scripts/consumer-creation-acl.ps1", import.meta.url));
const paths = [String.raw`C:\space [literal], apostrophe'\file`, String.raw`C:\雪-🦀\parent`, String.raw`C:\other\parent`];
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const reply = () => ({ rows: paths.map((file, index) => ({ index,
  pathBase64: Buffer.from(file, "utf8").toString("base64"),
  owner: "s-1-5-21-42", current: "s-1-5-21-42", present: true, protected: true,
  aces: [{ sid: "s-1-5-21-42", type: "AccessAllowed", mask: 0x1f01ff, flags: 3 }],
})) });

it.each([1, 2, 3])("encodes %i literal paths as one scalar and preserves the complete ordered reply", count => {
  const targets = paths.slice(0, count);
  const payload = encodeCreationAclBatch(targets);
  expect(payload).toMatch(/^[A-Za-z0-9+/]+=*$/);
  expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual({ paths: targets });
  const rows = reply().rows.slice(0, count);
  expect(decodeCreationAclBatch(targets, JSON.stringify({ rows }))).toEqual(rows);
});

it.each([[], [...paths, "fourth"], [paths[0], paths[0]], [""], ["bad\0path"], [1], [null]].map(targets => ({ targets })))(
  "rejects invalid requests before encoding: $targets", ({ targets }) => {
    expect(() => encodeCreationAclBatch(targets)).toThrow();
  },
);

it("rejects missing, extra, reordered, duplicate and mismatched result rows", () => {
  const mutations = [
    (value: ReturnType<typeof reply>) => { value.rows.pop(); },
    (value: ReturnType<typeof reply>) => { value.rows.push(value.rows[0]!); },
    (value: ReturnType<typeof reply>) => { value.rows.reverse(); },
    (value: ReturnType<typeof reply>) => { value.rows[1] = value.rows[0]!; },
    (value: ReturnType<typeof reply>) => { value.rows[1]!.index = 0; },
    (value: ReturnType<typeof reply>) => { value.rows[1]!.pathBase64 = value.rows[0]!.pathBase64; },
  ];
  for (const mutate of mutations) {
    const value = reply(); mutate(value);
    expect(() => decodeCreationAclBatch(paths, JSON.stringify(value))).toThrow();
  }
  for (const stdout of ["", "{", "null", "[]", "{}", '{"rows":{}}', '{"rows":[null,null,null]}']) {
    expect(() => decodeCreationAclBatch(paths, stdout)).toThrow();
  }
});

it.skipIf(process.platform !== "win32")("queries literal paths through native PowerShell 5.1 and rejects incomplete batches", async () => {
  const directory = await tempRoot("fs-safe-creation-acl-batch-");
  const targets = ["space [literal], apostrophe'", "雪-🦀", "third"].map(name => path.join(directory, name));
  await Promise.all(targets.map(file => fs.writeFile(file, "fixture")));
  const absent = path.join(directory, "missing");
  const invalid = [
    { name: "base64", payload: "%%%" },
    { name: "utf8", payload: Buffer.from([0xff]).toString("base64") },
    { name: "json", payload: Buffer.from("{").toString("base64") },
    ...[null, [], { paths: "scalar" }, { paths: [] }, { paths: [...targets, absent] }]
      .map((value, index) => ({ name: `shape-${index}`, payload: encoded(value) })),
    ...[[absent, 1], [absent, null], [absent, ""], [absent, "bad\0path"], [absent, absent]]
      .map((value, index) => ({ name: `target-${index}`, payload: encoded({ paths: value }) })),
    { name: "missing-middle", payload: encodeCreationAclBatch([targets[0]!, absent, targets[2]!]) },
  ];
  // One driver sets distinguishable raw DACLs and exercises decoder failures.
  // Positive queries below use the actual native -File scalar argument route.
  const setup = JSON.parse(runWindowsSecurityScript("", [
    "$fixture=Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $env:FS_SAFE_CREATION_ACL_FIXTURE",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "for($i=0;$i -lt $fixture.targets.Count;$i++) {",
    "  $sddl='O:'+$sid+'D:P(A;;FA;;;'+$sid+')'",
    "  if($i -ge 1){$sddl+='(A;;FA;;;SY)'}; if($i -ge 2){$sddl+='(A;;FA;;;BA)'}",
    "  $acl=[Security.AccessControl.FileSecurity]::new(); $acl.SetSecurityDescriptorSddlForm($sddl)",
    "  [IO.File]::SetAccessControl($fixture.targets[$i],$acl)",
    "}",
    "$failures=@(foreach($case in $fixture.invalid) {",
    "  $captured=[Collections.Generic.List[string]]::new(); $failed=$false; $message=''",
    "  try { & $env:FS_SAFE_CREATION_ACL_SCRIPT -EncodedTargets $case.payload | ForEach-Object { $captured.Add([string]$_) } }",
    "  catch { $failed=$true; $message=$_.Exception.Message }",
    "  @{name=$case.name;failed=$failed;output=@($captured);message=$message}",
    "})",
    "Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject @{version=$PSVersionTable.PSVersion.ToString();failures=$failures} -Depth 5 -Compress",
  ], {
    FS_SAFE_CREATION_ACL_SCRIPT: script,
    FS_SAFE_CREATION_ACL_FIXTURE: JSON.stringify({ targets, invalid }),
  }));
  expect(setup.version).toMatch(/^5\.1\./);
  expect(setup.failures.map((failure: { name: string }) => failure.name)).toEqual(invalid.map(value => value.name));
  for (const failure of setup.failures) {
    expect(failure.failed, failure.name).toBe(true);
    expect(failure.output, failure.name).toEqual([]);
    if (failure.name.startsWith("target-")) expect(failure.message).toBe("Invalid creation ACL target");
  }
  const query = (files: string[]) => decodeCreationAclBatch(files, execFileSync(
    resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-EncodedTargets", encodeCreationAclBatch(files)],
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
  ));
  const batch = query(targets);
  expect(batch.map(row => row.aces.length)).toEqual([1, 2, 3]);
  expect(query(targets.slice(0, 2))).toEqual(batch.slice(0, 2));
  for (const [index, file] of targets.entries()) {
    expect(batch[index]).toEqual({ ...query([file])[0], index });
    expect(batch[index]).toMatchObject({ present: true, protected: true });
  }
}, 45_000);
