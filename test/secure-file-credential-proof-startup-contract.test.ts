import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

let coordinatorPromise: Promise<string> | undefined;

function coordinatorSource(): Promise<string> {
  coordinatorPromise ??= readFile("scripts/secure-file-credential-proof.mjs", "utf8")
    .then((source) => source.replace(/\r\n?/gu, "\n"));
  return coordinatorPromise;
}

function startupReceipt(complete = true) {
  const credentials = () => ({
    uid: Array<boolean>(4).fill(complete), gid: Array<boolean>(4).fill(complete),
    caps: Array<boolean>(5).fill(complete), groupsCleared: complete,
    noNewPrivs: complete, processApi: complete,
  });
  return {
    schema: 1, proof: "secure-file-startup", tuple: "equal", complete,
    stage: complete ? "complete" : "ancestors", subject: complete ? "none" : "candidate-worker",
    operation: complete ? "none" : "chdir", code: complete ? "OK" : "EACCES",
    ancestorIndex: complete ? null : 7, ancestorsChecked: 8,
    credentialsBefore: credentials(), credentialsAfter: credentials(),
    runtime: { versionExact: complete, execPathExact: complete },
    checked: {
      candidateWorker: complete, candidatePackage: complete, historicalWorker: complete,
      historicalPackage: complete, candidateCwd: complete, historicalCwd: complete,
      secretsDirectory: complete,
    },
  };
}

async function startupContract() {
  const coordinator = await coordinatorSource();
  const contract = coordinator.match(
    /\/\/ BEGIN STARTUP PROBE CONTRACT\n(?<body>[\s\S]*?)\/\/ END STARTUP PROBE CONTRACT/u,
  )?.groups?.body;
  expect(contract).toBeDefined();
  // Evaluate only pure receipt helpers and the static string, never the inline probe or coordinator.
  return runInNewContext(`${contract}\n({
    parse: parseStartupReceipt, probe: STARTUP_PROBE_SOURCE,
    stages: STARTUP_STAGES, subjects: STARTUP_SUBJECTS,
    operations: STARTUP_OPERATIONS, codes: STARTUP_CODES,
  })`, { Buffer }, { timeout: 1000 }) as {
    parse: (output: Buffer, tuple: string) => ReturnType<typeof startupReceipt> | null;
    probe: string; stages: string[]; subjects: string[]; operations: string[]; codes: string[];
  };
}

describe("manual split-credential startup proof contract", () => {
  it("runs two static inline startup probes before cases without a worker-path bootstrap dependency", async () => {
    const coordinator = await coordinatorSource();
    const { probe } = await startupContract();
    const runner = coordinator.slice(coordinator.indexOf("async function runStartupProbe("),
      coordinator.indexOf("async function runProofCase("));
    expect(coordinator).toContain('const STARTUP_TUPLES = ["equal", "split"]');
    expect(runner).toContain('tools.node.path, "--input-type=module", "--eval", STARTUP_PROBE_SOURCE, "--", config');
    expect(probe).toContain("process.argv.length !== 2");
    expect(probe).toContain("JSON.parse(process.argv[1])");
    expect(probe).toContain("JSON.stringify(config) !== process.argv[1]");
    expect(probe).not.toContain("${");
    expect(probe).not.toMatch(/\b(?:eval|import|require)\s*\(|fs\.access|readFile|readdir|chmod|chown|unlink|\.secret/u);
    expect(probe).toContain('["secrets-directory", "secretsDirectory", path.join(config.fixture, "secrets")]');
    expect(probe).toContain("path.dirname(path.dirname(config.fixture)) !== path.dirname(config.node)");
    expect(runner).toContain('cwd: "/"');
    expect(runner).toContain('"--ruid", String(tuple === "equal" ? EFFECTIVE_UID : REAL_UID)');
    for (const token of ["tools.timeout.path", "tools.prlimit.path", "tools.strace.path", "tools.setpriv.path",
      '"--clear-groups"', '"--inh-caps=-all"', '"--ambient-caps=-all"', '"--bounding-set=-all"',
      '"--no-new-privs"', '"--core=0:0"', '"--fsize=1048576:1048576"', '"30s"', '"--kill-after=5s"',
      "timeoutMs: 40_000", "--string-limit=1", "--kill-on-exit", "await fs.unlink(tracePath)",
      "rawTracesRemoved = false", "traceStat.size >= BigInt(MAX_TRACE_BYTES)"]) {
      expect(runner).toContain(token);
    }
    const startup = coordinator.indexOf('stage = "startup-probes"');
    expect(startup).toBeGreaterThan(coordinator.indexOf('proofError("FIXTURE_WRITABLE")'));
    expect(startup).toBeLessThan(coordinator.indexOf('stage = "credential-cases"'));
    expect(coordinator).toContain('await timed("startupProbes"');
    expect(coordinator).toContain('await timed(`startup-${tuple}`');
    expect(coordinator).toContain("startupReceipts.length === STARTUP_TUPLES.length");
    expect(coordinator).toContain("failure === null &&\n    startupComplete &&\n    allCasesComplete");
  });

  it("checks dropped identities and exact bounded file admission without reading secret files", async () => {
    const coordinator = await coordinatorSource();
    const { probe } = await startupContract();
    for (const token of [
      'await credentials(config, "credentials-before")', 'await credentials(config, "credentials-after")',
      '[config.tuple === "equal" ? 61002 : 61001, 61002, 61002, 61002]',
      'gids.map((value) => value === 61003)', 'fields.get("Groups") === ""',
      'apiGroups.length === 1 && apiGroups[0] === 61003',
      '"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"',
      'readBounded(handle, 16384)', 'process.version === config.expectedNode',
      'await fs.realpath(process.execPath) === config.node',
      'nodeMatch[3] !== config.expectedNode.slice(1)', 'expected.path !== targets[index][2]',
      'config.files.length !== 4', 'expected.bytes > 1048576', 'chain.length >= 32', 'ancestors.size >= 32',
      'await fs.realpath(directory) !== directory', 'process.chdir(directory)',
      'constants.O_RDONLY | constants.O_NOFOLLOW', 'before.uid !== 0n', 'before.gid !== 0n',
      'before.nlink !== 1n', '(before.mode & 0o7777n) !== 0o444n',
      'String(before.dev) !== expected.dev', 'String(before.ino) !== expected.ino',
      'readBounded(handle, expected.bytes)', 'createHash("sha256").update(buffer).digest("hex") !== expected.sha256',
      'stat.mtimeNs, stat.ctimeNs', 'await handle.close()',
      'if (fileComplete) receipt.operation = "close"',
    ]) expect(probe).toContain(token);
    expect(coordinator).toContain('harnessReceipt.workerSha256]');
    expect(coordinator).toContain('libraryReceipts[role].packageSha256]');
    expect(coordinator).toContain('sha256(buffer) !== expectedHash');
    expect(probe.match(/"worker\.mjs"/gu)).toHaveLength(2);
    expect(probe.match(/"package\.json"/gu)).toHaveLength(2);
    expect(probe.match(/"secrets"/gu)).toHaveLength(1);
  });

  it("accepts only exact finite startup receipts and requires every success observation", async () => {
    const { parse } = await startupContract();
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
    for (const tuple of ["equal", "split"]) {
      const value = { ...startupReceipt(), tuple };
      expect(parse(encode(value), tuple)).toEqual(value);
    }
    expect(parse(encode(startupReceipt(false)), "equal")).toEqual(startupReceipt(false));
    const valid = encode(startupReceipt());
    for (const input of [Buffer.alloc(0), Buffer.alloc(1025, 32), valid.subarray(0, valid.length - 1),
      Buffer.from(" " + valid.toString()), Buffer.from(valid.toString() + "\n"),
      Buffer.from(valid.toString().replace('"schema":1', '"schema":1,"schema":1')),
      Buffer.from(valid.toString().replace('"complete"', '"compl\\u0065te"')),
      Buffer.from(valid.toString().replace('"none"', '"/private/path"'))]) {
      expect(parse(input, "equal")).toBeNull();
    }
    for (const value of [
      { ...startupReceipt(), schema: 2 }, { ...startupReceipt(), tuple: "split" },
      { ...startupReceipt(), extra: true }, { ...startupReceipt(), code: "EACCES" },
      { ...startupReceipt(), complete: false }, { ...startupReceipt(), ancestorIndex: 1 },
      { ...startupReceipt(), ancestorsChecked: 0 }, { ...startupReceipt(), ancestorsChecked: 33 },
      { ...startupReceipt(), credentialsBefore: null },
      { ...startupReceipt(), runtime: { versionExact: true, execPathExact: false } },
      { ...startupReceipt(), checked: { ...startupReceipt().checked, candidateWorker: false } },
      { ...startupReceipt(), checked: {
        "candidateCwd,candidatePackage": true,
        candidateWorker: true, historicalCwd: true, historicalPackage: true,
        historicalWorker: true, secretsDirectory: true,
      } },
      { ...startupReceipt(false), stage: "raw-stage" }, { ...startupReceipt(false), code: "raw-code" },
      { ...startupReceipt(false), operation: "raw-operation" }, { ...startupReceipt(false), subject: "raw-subject" },
      { ...startupReceipt(false), ancestorIndex: -1 }, { ...startupReceipt(false), ancestorIndex: 32 },
      { ...startupReceipt(false), ancestorIndex: 1.5 }, { ...startupReceipt(false), code: "OK" },
    ]) expect(parse(encode(value), "equal")).toBeNull();
    for (const phase of ["credentialsBefore", "credentialsAfter"] as const) {
      for (const kind of ["uid", "gid", "caps"] as const) {
        const value = startupReceipt();
        for (let index = 0; index < value[phase][kind].length; index++) {
          const changed = startupReceipt();
          changed[phase][kind][index] = false;
          expect(parse(encode(changed), "equal")).toBeNull();
        }
      }
      for (const key of ["groupsCleared", "noNewPrivs", "processApi"] as const) {
        const value = startupReceipt();
        value[phase][key] = false;
        expect(parse(encode(value), "equal")).toBeNull();
      }
    }
  });

  it("fits the entire finite startup schema in 1024 bytes and retains at most eight diagnostics", async () => {
    const coordinator = await coordinatorSource();
    const { probe, stages, subjects, operations, codes } = await startupContract();
    const longest = (values: string[]) => values.reduce((left, right) => left.length >= right.length ? left : right);
    const largest = { ...startupReceipt(false), stage: longest(stages), subject: longest(subjects),
      operation: longest(operations), code: longest(codes), ancestorsChecked: 32, ancestorIndex: null };
    expect(Buffer.byteLength(JSON.stringify(largest) + "\n")).toBeLessThanOrEqual(1024);
    expect(probe).toContain("if (Buffer.byteLength(output) <= 1024) process.stdout.write(output)");
    const diagnostic = coordinator.slice(coordinator.indexOf("function startupFailureDiagnostic("),
      coordinator.indexOf("async function runStartupProbe("));
    expect(diagnostic).not.toMatch(/\.toString\(|\.message|\.stack|\.path/u);
    expect(diagnostic).toContain("{ reason, exitCode, tuple, stdoutBytes: run.stdout.length, stderrBytes: run.stderr.length }");
    expect(diagnostic).toContain("{ reason, exitCode, tuple, probeStage: receipt.stage, subject: receipt.subject");
    expect(diagnostic).toContain("operation: receipt.operation, probeCode: receipt.code");
    expect(diagnostic).toContain("ancestorIndex: receipt.ancestorIndex");
  });
});
