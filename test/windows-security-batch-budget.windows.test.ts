import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { runWindowsSecurityScript } from "./helpers/windows-security-script.js";

const SCRIPT = fs.readFileSync(new URL("../src/windows-security-bridge.ps1", import.meta.url), "utf8");
const ADD_TYPE = "Microsoft.PowerShell.Utility\\Add-Type -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'windows-security-bridge.cs'))";
const SERIALIZE_ROW = "      $rowJson = Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject ([ordered]@{ path = $pathname; security = $reply.result }) -Depth 8 -Compress";
const WRITE_SUCCESS = "      [Console]::Write($encoded.ToString())";
const { tempRoot } = useTempDirs();

// The real production PowerShell loop and serializer run against observable facts.
// No Windows ACL or filesystem query is made by this test-only C# fixture.
const FIXTURE = String.raw`
using System;
using System.Collections.Generic;
public static class FsSafeWindowsBridge {
  static readonly List<string> queries = new List<string>();
  static Dictionary<string,object> Row(params object[] fields) {
    var row = new Dictionary<string,object>();
    for(int i=0;i<fields.Length;i+=2) row.Add((string)fields[i],fields[i+1]);
    return row;
  }
  static object Security(int ordinal) {
    return Row("ownerSid","s-1-5-21-42","currentUserSid","s-1-5-21-42",
      "daclPresent",true,"daclProtected",true,"isLocal",true,"aceListComplete",true,
      "unsupportedAceTypes",new int[0],"aces",new object[]{
        Row("sid","s-1-5-21-42","mask",ordinal,"aceType","allow",
          "flags",Row("raw",0,"objectInherit",false,"containerInherit",false,
            "noPropagateInherit",false,"inheritOnly",false,"inherited",false,
            "successfulAccess",false,"failedAccess",false))});
  }
  public static object Execute(string operation,string path) {
    if(operation!="path") throw new Exception("unexpected fixture operation");
    queries.Add(path);
    if(path=="missing") return Row("ok",false,"code","ENOENT","message","fixture missing path");
    if(path=="denied") return Row("ok",false,"code","EACCES","message","fixture access denied");
    return Row("ok",true,"result",Security(queries.Count));
  }
  public static object Expected(string[] paths) {
    var rows = new object[paths.Length];
    for(int i=0;i<paths.Length;i++) rows[i]=Row("path",paths[i],"security",Security(i+1));
    return Row("ok",true,"result",rows);
  }
  public static string[] Paths() { return queries.ToArray(); }
}
`;

function replaceOnce(source: string, needle: string, replacement: string): string {
  if (source.indexOf(needle) < 0 || source.indexOf(needle) !== source.lastIndexOf(needle)) {
    throw new Error("Windows batch fixture requires exactly one replacement site");
  }
  return source.replace(needle, replacement);
}

function fixtureScript(source: string, fault?: "serializer" | "output"): string {
  // The existing helper compiles our adjacent fixture before invoking this copy.
  let script = replaceOnce(source.replaceAll("\r\n", "\n"), ADD_TYPE, "# Fixture already compiled by the test helper.");
  if (fault === "serializer") script = replaceOnce(script, SERIALIZE_ROW, "      throw 'fixture serializer failure'");
  if (fault === "output") script = replaceOnce(script, WRITE_SUCCESS, "      throw 'fixture output failure'");
  return script;
}

type Reply = {
  ok: boolean;
  code?: string;
  message?: string;
  result?: { path: string; security: { aces: { mask: number }[] } }[];
};
type Trace = { paths: string[]; expected: string; expectedBytes: number; limit: number };

async function runBatch(input: string, options: {
  expectedPaths?: readonly string[];
  budgetOffset?: number;
  fault?: "serializer" | "output";
} = {}): Promise<{ stdout: string; reply: Reply; trace: Trace }> {
  const directory = await tempRoot("fs-safe-win-batch-budget-");
  const scriptFile = path.join(directory, "batch.ps1");
  const inputFile = path.join(directory, "input.json");
  const traceFile = path.join(directory, "trace.json");
  fs.writeFileSync(scriptFile, fixtureScript(SCRIPT, options.fault));
  fs.writeFileSync(inputFile, input);
  const inputFd = fs.openSync(inputFile, "r");
  try {
    const stdout = runWindowsSecurityScript(FIXTURE, [
      "$oracle=Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject ([Environment]::GetEnvironmentVariable('FS_SAFE_BATCH_ORACLE'))",
      "$expected=Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject ([FsSafeWindowsBridge]::Expected([string[]]$oracle.paths)) -Depth 8 -Compress",
      "$expectedBytes=[Console]::OutputEncoding.GetByteCount($expected)",
      "$cap=16*1024*1024",
      "$source=[IO.File]::ReadAllText([Environment]::GetEnvironmentVariable('FS_SAFE_BATCH_SCRIPT'))",
      "if([Environment]::GetEnvironmentVariable('FS_SAFE_BATCH_EXACT') -eq '1') {",
      "  $cap=$expectedBytes+[int][Environment]::GetEnvironmentVariable('FS_SAFE_BATCH_OFFSET')",
      "  if(([regex]::Matches($source,[regex]::Escape('$limit = 16 * 1024 * 1024'))).Count -ne 1) { throw 'ambiguous fixture limit' }",
      "  $source=$source.Replace('$limit = 16 * 1024 * 1024','$limit = '+$cap)",
      "}",
      "& ([ScriptBlock]::Create($source)) -Operation paths",
      "$trace=[ordered]@{paths=@([FsSafeWindowsBridge]::Paths());expected=$expected;expectedBytes=$expectedBytes;limit=$cap}",
      "[IO.File]::WriteAllText([Environment]::GetEnvironmentVariable('FS_SAFE_BATCH_TRACE'),(Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject $trace -Depth 4 -Compress),[Text.UTF8Encoding]::new($false))",
    ], {
      FS_SAFE_BATCH_SCRIPT: scriptFile,
      FS_SAFE_BATCH_TRACE: traceFile,
      FS_SAFE_BATCH_ORACLE: JSON.stringify({ paths: options.expectedPaths ?? [] }),
      FS_SAFE_BATCH_EXACT: options.budgetOffset === undefined ? "0" : "1",
      FS_SAFE_BATCH_OFFSET: String(options.budgetOffset ?? 0),
    }, inputFd);
    return { stdout, reply: JSON.parse(stdout) as Reply, trace: JSON.parse(fs.readFileSync(traceFile, "utf8")) as Trace };
  } finally {
    fs.closeSync(inputFd);
  }
}

it.each(["\n", "\r\n"])("prepares the real batch script fixture with %j line endings", newline => {
  const source = SCRIPT.replaceAll("\r\n", "\n").replaceAll("\n", newline);
  const prepared = fixtureScript(source);
  expect(prepared).not.toContain(ADD_TYPE);
  expect(prepared).toContain("$limit = 16 * 1024 * 1024");
  expect(fixtureScript(source, "serializer")).toContain("throw 'fixture serializer failure'");
  expect(fixtureScript(source, "output")).toContain("throw 'fixture output failure'");
});

describe.runIf(process.platform === "win32")("Windows PowerShell batch encoded-output budget", () => {
  it.each([
    { label: "empty", paths: [] },
    { label: "singleton", paths: ["first"] },
    { label: "multiple", paths: ["first", "second"] },
    { label: "duplicates", paths: ["same", "same", "same"] },
    { label: "Unicode and escaping", paths: ["é-雪-🦀", "quote\"-slash\\", "line\n\ttab"] },
  ])("accepts $label at the exact encoded envelope limit", async ({ paths }) => {
    const result = await runBatch(JSON.stringify(paths), { expectedPaths: paths, budgetOffset: 0 });
    expect(result.reply).toEqual(JSON.parse(result.trace.expected));
    expect(result.trace.paths).toEqual(paths);
    expect(result.reply.result?.map(row => row.path)).toEqual(paths);
    expect(result.reply.result?.map(row => row.security.aces[0]!.mask)).toEqual(paths.map((_, index) => index + 1));
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(result.trace.limit);
    expect(result.stdout.endsWith("\n")).toBe(false);
  }, 45_000);

  it("rejects a document one encoded byte above the cap without a success prefix", async () => {
    const paths = ["é-雪-🦀", "quote\"-slash\\"];
    const result = await runBatch(JSON.stringify(paths), { expectedPaths: paths, budgetOffset: -1 });
    expect(result.trace.expectedBytes).toBe(result.trace.limit + 1);
    expect(result.reply).toEqual({ ok: false, code: "too-large", message: "Windows security batch exceeded its output budget" });
    expect(result.trace.paths).toEqual(paths);
    expect(result.stdout).not.toContain('"result"');
  }, 45_000);

  it.each([
    JSON.stringify(["first", 1]), JSON.stringify(["first", ["nested"]]),
    JSON.stringify(["first", ""]), JSON.stringify(["first", "bad\0path"]),
    '["first"],"injected":[]', '"not an array"',
  ])("validates the complete input before querying: %s", async input => {
    const result = await runBatch(input);
    expect(result.reply).toEqual({ ok: false, code: "EINVAL", message: "Invalid Windows security path batch" });
    expect(result.trace.paths).toEqual([]);
  }, 45_000);

  it("stops at overflow before a later missing sentinel", async () => {
    const result = await runBatch(JSON.stringify(["first", "second", "missing"]), { expectedPaths: ["first"], budgetOffset: 0 });
    expect(result.reply.code).toBe("too-large");
    expect(result.trace.paths).toEqual(["first", "second"]);
    expect(result.stdout).not.toContain('"result"');
  }, 45_000);

  it.each([
    { path: "missing", code: "ENOENT", message: "fixture missing path" },
    { path: "denied", code: "EACCES", message: "fixture access denied" },
  ])("retains the first observed $code before later queries", async failure => {
    const result = await runBatch(JSON.stringify(["first", failure.path, "later"]), { expectedPaths: ["first"], budgetOffset: 0 });
    expect(result.reply).toEqual({ ok: false, code: failure.code, message: failure.message });
    expect(result.trace.paths).toEqual(["first", failure.path]);
    expect(result.stdout).not.toContain('"result"');
  }, 45_000);

  it.each(["serializer", "output"] as const)("keeps %s exceptions as transport failures", async fault => {
    let failure: unknown;
    try { await runBatch('["first"]', { fault }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const result = failure as { stdout?: string | Buffer; stderr?: string | Buffer };
    expect(result.stdout?.toString()).toBe("");
    expect(result.stderr?.toString()).toContain(`fixture ${fault} failure`);
  }, 45_000);
});
