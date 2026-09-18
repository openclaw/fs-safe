import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedConsumerEnv } from "./consumer-install-smoke.mjs";
import { windowsSecurityFixturePhases } from "./consumer-proof-metadata.mjs";

const MAX_OUTPUT = 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const systemModulePrelude = "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')\n";
const environmentKeys = ["PSModulePath", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH"];
const runtimeKeys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PSModulePath", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "SystemDrive",
  "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS"];

export function runtimeProfileControlEnv(isolated, ambient) {
  const result = { ...isolated };
  const names = Object.keys(ambient);
  for (const key of runtimeKeys) {
    for (const existing of Object.keys(result)) if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
    const original = names.find(name => name.toLowerCase() === key.toLowerCase());
    if (original !== undefined) result[key] = ambient[original];
  }
  return result;
}

export function extractRawFixture(source, name) {
  const prefix = `const ${name} = String.raw\``;
  assert.equal(source.split(prefix).length, 2);
  const body = source.slice(source.indexOf(prefix) + prefix.length);
  const end = body.indexOf("`;");
  assert(end >= 0);
  const value = body.slice(0, end);
  assert(!value.includes("${") && !value.includes("`"));
  return value;
}

export function runFixtureWorker({ file, args, stdin }) {
  const started = performance.now();
  // Match the original consumer's synchronous invocation; the outer Node
  // supervisor observes descendants without changing this stdio mechanism.
  const result = spawnSync(file, args, { env: { ...process.env }, encoding: "utf8", windowsHide: true,
    timeout: 30_000, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    ...(stdin === "ignore" ? { stdio: ["ignore", "pipe", "pipe"] } : {}),
  });
  return { pid: result.pid, elapsedMs: Math.round(performance.now() - started),
    exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function completedProcess(result) {
  return result?.exitConfirmed === true && result.outputClosed === true &&
    result.exitCode === 0 && result.signal === null && !result.timedOut && !result.errorCode;
}

export function canContinueCompilerControls(supervisor, fixture) {
  return completedProcess(supervisor) && (supervisor.snapshots ?? []).every(snapshot =>
    completedProcess(snapshot) && snapshot.processes?.protocol === 1 &&
    snapshot.processes.ok === true && snapshot.processes.rootValidated === true &&
    snapshot.processes.truncated === false) &&
    fixture?.exitCode === 0 && fixture.signal === null && !fixture.errorCode;
}

function discoveryPhases(stderr) {
  const phases = [];
  for (const match of stderr.matchAll(/^FS_SAFE_COMPILER_CONTROL:((?:script|command-discovery|source-read|runtime-facts):(?:start|end)):(\d{1,9})\r?$/gm)) {
    phases.push({ step: match[1], childElapsedMs: Number(match[2]) });
    if (phases.length === 16) break;
  }
  return phases;
}

export function ownedTempInventory(directory) {
  const extensions = {};
  let files = 0;
  let directories = 0;
  let truncated = false;
  let errorCode = null;
  const pending = [{ directory, depth: 0 }];
  try {
    while (pending.length) {
      const current = pending.shift();
      for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
        if (files + directories >= 128) { truncated = true; pending.length = 0; break; }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          directories++;
          if (current.depth < 3) pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
          else truncated = true;
        } else if (entry.isFile()) {
          files++;
          const extension = path.extname(entry.name).toLowerCase();
          const bucket = [".tmp", ".cmdline", ".out", ".err", ".dll", ".cs", ".pdb"].includes(extension) ? extension : "other";
          extensions[bucket] = (extensions[bucket] ?? 0) + 1;
        }
      }
    }
  } catch (error) { errorCode = error.code ?? "inspection-failed"; }
  return { files, directories, extensions, truncated, errorCode };
}

// Diagnostic children keep the same 30s compilation budget. A failed kill or
// inherited pipe cannot leave this separate CI control waiting indefinitely.
export function runDiagnosticProcess(file, args, { cwd, env, stdin = "pipe", timeoutMs = 30_000, snapshot } = {}) {
  const started = performance.now();
  const startedAfter = new Date(Date.now() - 1_000).toISOString();
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: [stdin, "pipe", "pipe"] });
    const startedBefore = new Date(Date.now() + 1_000).toISOString();
    const buffers = { stdout: [], stderr: [] };
    const samples = [];
    const sampleTimers = [];
    let bytes = 0;
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let exitConfirmed = false;
    let exitCode = null;
    let signal = null;
    let errorCode = null;
    let terminationSignalSent;
    let terminationErrorCode;
    let grace;
    const finish = outputClosed => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      for (const timer of sampleTimers) clearTimeout(timer);
      if (!outputClosed) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!exitConfirmed) child.unref();
      }
      const result = { pid: child.pid ?? null, elapsedMs: Math.round(performance.now() - started),
        timedOut, exitConfirmed, outputClosed, exitCode, signal, errorCode,
        terminationSignalSent, terminationErrorCode,
        stdout: Buffer.concat(buffers.stdout).toString("utf8"), stderr: Buffer.concat(buffers.stderr).toString("utf8") };
      buffers.stdout.length = 0;
      buffers.stderr.length = 0;
      Promise.all(samples).then(snapshots => resolve({ ...result, snapshots }));
    };
    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(deadline);
      grace = setTimeout(() => finish(false), 1_000);
      if (!exitConfirmed) {
        try { terminationSignalSent = child.kill("SIGKILL"); }
        catch (error) { terminationErrorCode = error.code ?? "termination-failed"; }
      }
    };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.on("data", chunk => {
        if (settled || stopping) return;
        bytes += chunk.length;
        if (bytes <= MAX_OUTPUT) buffers[stream].push(chunk);
        else { errorCode = "output-limit"; stop(); }
      });
      child[stream]?.on("error", error => { if (!settled) { errorCode ??= error.code ?? "pipe-error"; stop(); } });
    }
    child.on("error", error => {
      if (settled) return;
      if (stopping) terminationErrorCode ??= error.code ?? "process-error";
      else { errorCode = error.code ?? "spawn-error"; stop(); }
    });
    child.once("exit", (code, exitSignal) => { exitConfirmed = true; exitCode = code; signal = exitSignal; });
    child.once("close", (code, exitSignal) => {
      exitConfirmed = true; exitCode = code; signal = exitSignal;
      if (!stopping && performance.now() - started >= timeoutMs) timedOut = true;
      finish(true);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end();
    if (snapshot && child.pid) {
      for (const delay of [5_000, 20_000]) {
        sampleTimers.push(setTimeout(() => {
          if (settled || stopping) return;
          samples.push(Promise.resolve().then(() => snapshot({ pid: child.pid, startedAfter, startedBefore }))
            .catch(() => ({ status: "snapshot-failed" })));
        }, delay));
      }
    }
  });
}

export async function main() {
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ protocol: 1, status: "unsupported-platform" }));
    return;
  }
  const root = path.resolve(import.meta.dirname, "..");
  const probe = fs.readFileSync(path.join(root, "scripts/consumer-windows-security-probe.mjs"), "utf8");
  const fixtureSource = extractRawFixture(probe, "aclSource");
  const fixtureScript = extractRawFixture(probe, "aclScript");
  const powershell = path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const rows = [];
  const scenarios = ["system-modules-command-discovery", "system-modules-fixture", "isolated-command-discovery", "isolated-fixture"];
  let stoppedAfter = null;
  for (const scenario of scenarios) {
    const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-consumer-proof-")));
    const consumer = path.join(temporary, "npm-normal");
    fs.mkdirSync(consumer);
    const configuration = path.join(consumer, "config");
    const isolated = isolatedConsumerEnv(configuration);
    const env = isolated;
    const sandbox = fs.mkdtempSync(path.join(consumer, "windows-security-proof-"));
    const driver = path.join(sandbox, "consumer-raw-security.ps1");
    const systemModulesOnly = scenario.startsWith("system-modules-");
    const executedFixtureScript = (systemModulesOnly ? systemModulePrelude : "") + fixtureScript;
    fs.writeFileSync(driver, executedFixtureScript, { flag: "wx" });
    fs.writeFileSync(path.join(sandbox, "consumer-raw-security.cs"), fixtureSource, { flag: "wx" });
    env.FS_SAFE_SECURITY_PROOF_PATH = sandbox;
    env.FS_SAFE_SECURITY_PROOF_ACTION = "parent";
    const discovery = scenario.endsWith("command-discovery");
    const discoveryScript = path.join(sandbox, "compiler-discovery.ps1");
    if (discovery) fs.copyFileSync(path.join(import.meta.dirname, "windows-security-compiler-discovery.ps1"), discoveryScript);
    const script = discovery ? discoveryScript : driver;
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
      ...(discovery
        ? ["-SourcePath", path.join(sandbox, "consumer-raw-security.cs"), "-ConfiguredTemp", configuration,
          ...(systemModulesOnly ? ["-SystemModulesOnly"] : [])] : [])];
    const stdin = "pipe";
    const workerConfiguration = path.join(consumer, "diagnostic-worker.json");
    fs.writeFileSync(workerConfiguration, JSON.stringify({ file: powershell, args, stdin }));
    const before = ownedTempInventory(configuration);
    console.error(JSON.stringify({ diagnostic: "windows-add-type", scenario, phase: "start" }));
    const result = await runDiagnosticProcess(process.execPath, [fileURLToPath(import.meta.url), "--fixture-worker", workerConfiguration], {
      cwd: consumer, env, stdin: "pipe", timeoutMs: 31_000,
      snapshot: async ({ pid, startedAfter, startedBefore }) => {
        const state = await runDiagnosticProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
          path.join(import.meta.dirname, "windows-security-compiler-state.ps1"), "-RootProcessId", String(pid),
          "-RootProcessName", "node.exe", "-StartedAfter", startedAfter, "-StartedBefore", startedBefore], {
          cwd: root, env: runtimeProfileControlEnv(isolated, process.env), stdin: "ignore", timeoutMs: 4_000,
        });
        let processes;
        try { if (state.exitCode === 0 && !state.timedOut) processes = JSON.parse(state.stdout); } catch {}
        return { elapsedMs: state.elapsedMs, exitCode: state.exitCode, signal: state.signal, timedOut: state.timedOut,
          exitConfirmed: state.exitConfirmed, outputClosed: state.outputClosed,
          errorCode: state.errorCode, terminationSignalSent: state.terminationSignalSent,
          terminationErrorCode: state.terminationErrorCode, processes: processes ?? { status: "unavailable" },
          ownedConfigurationFiles: ownedTempInventory(configuration) };
      },
    });
    let fixture;
    try { if (result.exitCode === 0 && !result.timedOut) fixture = JSON.parse(result.stdout); } catch {}
    let ordinaryCompletion = canContinueCompilerControls(result, fixture);
    let validOutput = false;
    let discoveryResult;
    try {
      const value = JSON.parse(fixture.stdout);
      validOutput = discovery ? value.commandFound === true && value.sourceReadable === true
        : value.complete === true && value.daclPresent === true && Array.isArray(value.aces);
      if (discovery && systemModulesOnly) validOutput &&= value.systemModuleSearchOnly === true && value.commandFromSystemModules === true;
      if (discovery) discoveryResult = value;
    } catch {}
    let runtimePolicy;
    if (ordinaryCompletion && validOutput && !discovery) {
      const policyScript = path.join(sandbox, "runtime-policy.ps1");
      fs.copyFileSync(path.join(import.meta.dirname, "windows-security-compiler-policy.ps1"), policyScript);
      const policy = await runDiagnosticProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", policyScript,
        ...(systemModulesOnly ? ["-SystemModulesOnly"] : [])], {
        cwd: consumer, env, stdin: "ignore", timeoutMs: 4_000,
      });
      ordinaryCompletion &&= completedProcess(policy);
      try { if (completedProcess(policy)) runtimePolicy = JSON.parse(policy.stdout); } catch {}
      runtimePolicy ??= { status: "unavailable", timedOut: policy.timedOut, errorCode: policy.errorCode,
        exitConfirmed: policy.exitConfirmed, outputClosed: policy.outputClosed, exitCode: policy.exitCode, signal: policy.signal };
    }
    const { stdout, stderr, ...observation } = result;
    const presentKeys = new Set(Object.keys(env).map(key => key.toLowerCase()));
    const row = { scenario, environment: "isolated-consumer",
      stdin, cwd: "fresh-consumer", systemModulesOnly, compilationBudgetMs: 30_000,
      supervisorBudgetMs: 31_000,
      environmentPresence: Object.fromEntries(environmentKeys.map(key => [key, presentKeys.has(key.toLowerCase())])),
      fixtureSourceSha256: sha256(fixtureSource), fixtureScriptSha256: sha256(fixtureScript),
      ...(!discovery ? { executedFixtureScriptSha256: sha256(executedFixtureScript) } : {}),
      supervisor: observation, fixture: fixture ? { pid: fixture.pid, elapsedMs: fixture.elapsedMs,
        exitCode: fixture.exitCode, signal: fixture.signal, errorCode: fixture.errorCode } : { status: "unavailable" },
      stdoutBytes: Buffer.byteLength(fixture?.stdout ?? ""), stderrBytes: Buffer.byteLength(fixture?.stderr ?? ""), validOutput,
      passed: ordinaryCompletion && validOutput,
      phases: discovery ? discoveryPhases(fixture?.stderr ?? "") : windowsSecurityFixturePhases(fixture?.stderr),
      ...(discoveryResult ? { discovery: discoveryResult } : {}), ownedConfigurationBefore: before,
      ...(runtimePolicy ? { runtimePolicy, runtimePolicyScope: "Separate process after the fixture, same environment and directory; no policy changes." } : {}),
      ownedConfigurationAfter: ownedTempInventory(configuration) };
    rows.push(row);
    console.error(JSON.stringify({ diagnostic: "windows-add-type", scenario, phase: "complete", observation: row }));
    if (!ordinaryCompletion || !validOutput) {
      // Killing the worker cannot confirm PowerShell/compiler descendant exit.
      // End these controls instead of running comparisons beside an orphan.
      stoppedAfter = scenario;
      break;
    }
  }
  const receipt = { protocol: 1, node: process.version, platform: process.platform, arch: process.arch,
    scope: "Fixture-only diagnostic controls, not an installed-package proof. The workflow runs them after proof failure and does not replace that result. No environment values, command lines or file contents are collected; policies are only read.",
    environmentControl: "Each control keeps the same isolated consumer environment. Only the read-only process samplers restore allowlisted runtime/profile/system variables. Installer configuration and baseline policy inputs stay unchanged; ambient policy overrides, auth, NODE_OPTIONS and arbitrary environment variables are not restored.",
    systemModuleControl: "The first two controls change only PSModulePath inside the child script to the launched PowerShell installation's Modules directory, before command discovery. Fresh profile, temp, stdin, source, policies and deadlines stay unchanged. Their policy observer uses the same module scope. Later unmodified controls test whether cache warming alone explains success.",
    cacheCaution: "Fresh processes share machine caches. Unmodified isolated discovery/fixture baselines run after the scoped-module controls to check whether cache warming alone explains success.",
    processCaution: "The failed package proof may already have left compiler descendants. These observations alone cannot establish causality. A failed or unconfirmed fixture stops subsequent controls; terminating its direct worker does not prove descendant exit. The failed ephemeral CI job must end before further comparisons.",
    stoppedAfter, unrunScenarios: scenarios.slice(rows.length),
    ...(stoppedAfter ? { descendantSettlement: "unconfirmed", runnerTeardownRequired: true } : {}),
    temporaryDirectoriesRetained: true, rows };
  const output = path.join(root, "release-artifacts/windows-security-compiler-diagnostic.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  if (stoppedAfter) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === "--fixture-worker") {
    console.log(JSON.stringify(runFixtureWorker(JSON.parse(fs.readFileSync(process.argv[3], "utf8")))));
  } else await main();
}
