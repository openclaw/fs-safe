import { afterAll, beforeAll } from "vitest";

/** Keep setup and test work alive until it is safe to remove a shared fixture. */
export function useSuiteFixture<Fixture>(
  prepare: () => Promise<Fixture>,
  cleanup: () => Promise<void>,
  setupTimeoutMs = 30_000,
): <Result>(operation: (fixture: Fixture) => Promise<Result>) => Promise<Result> {
  let fixture: Fixture;
  let pending: Promise<unknown> = Promise.resolve();
  let closing = false;

  function track<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (closing) return Promise.reject(new Error("suite fixture is closing"));
    const result = pending.then(operation);
    // Return the rejection to Vitest, but still allow teardown to drain it.
    pending = result.catch(() => undefined);
    return result;
  }

  beforeAll(() => track(async () => { fixture = await prepare(); }), setupTimeoutMs);
  afterAll(async () => {
    closing = true;
    // Vitest timeouts do not cancel fs.cp or pending filesystem operations.
    await pending;
    await cleanup();
  }, setupTimeoutMs);

  return (operation) => track(() => operation(fixture));
}
