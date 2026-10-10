export const RELEASE_PACKAGE_CONCURRENCY = 4;

/** Preserve manifest order and settle an entire batch before returning a failure. */
export async function mapReleasePackages(artifacts, operation) {
  const values = [];
  for (let offset = 0; offset < artifacts.length; offset += RELEASE_PACKAGE_CONCURRENCY) {
    const batch = artifacts.slice(offset, offset + RELEASE_PACKAGE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (artifact) => operation(artifact)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      values.push(result.value);
    }
  }
  return values;
}
