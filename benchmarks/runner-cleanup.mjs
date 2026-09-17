import fs from "node:fs";

export async function attemptBenchmarkCleanup(failures, action) {
  try {
    await action();
  } catch (error) {
    failures.push(error);
  }
}

export function throwBenchmarkFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

export async function finishBenchmarkInvocation(failures, after, message) {
  await attemptBenchmarkCleanup(failures, after);
  throwBenchmarkFailures(failures, message);
}

export async function finalizeBenchmarkRun({ initialFailures = [], cleanup, cleanups = [], workspace }) {
  const failures = [...initialFailures];

  if (cleanup) await attemptBenchmarkCleanup(failures, cleanup);
  for (const callback of [...cleanups].reverse()) {
    await attemptBenchmarkCleanup(failures, callback);
  }
  await attemptBenchmarkCleanup(failures, () => fs.rmSync(workspace, { recursive: true, force: true }));

  throwBenchmarkFailures(failures, "benchmark execution or cleanup failed");
}

export async function finalizeBenchmarkReport({
  initialFailures = [],
  validateReport,
  cleanup,
  cleanups = [],
  workspace,
  reportPath,
  report,
}) {
  const failures = [...initialFailures];
  if (failures.length === 0) {
    await attemptBenchmarkCleanup(failures, validateReport);
  }
  await finalizeBenchmarkRun({ initialFailures: failures, cleanup, cleanups, workspace });
  if (reportPath) {
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}
