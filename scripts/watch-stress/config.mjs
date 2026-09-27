// Keep qualification defaults here; scheduled CI supplies its smaller workload
// through environment variables inherited by the harness's child processes.
export function positiveInteger(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

export const settings = {
  scaleDirectories: positiveInteger("FS_SAFE_STRESS_SCALE_DIRECTORIES", 2000),
  fanout: positiveInteger("FS_SAFE_STRESS_FANOUT", 256),
  churnSeconds: positiveInteger("FS_SAFE_STRESS_CHURN_SECONDS", 300),
  lifecycleCycles: positiveInteger("FS_SAFE_STRESS_LIFECYCLE_CYCLES", 10_000, 10),
  idleSeconds: positiveInteger("FS_SAFE_STRESS_IDLE_SECONDS", 600),
  soakMinutes: positiveInteger("FS_SAFE_STRESS_SOAK_MINUTES", 60, 10),
};
