import { FsSafeError } from "./errors.js";

export class MutationAuthorityError extends FsSafeError {
  constructor(readonly rejection: unknown) {
    super("denied-path", "mutation authority rejected the operation", { cause: rejection });
  }
}

function assertSynchronous(returned: unknown): void {
  if (
    returned !== null &&
    (typeof returned === "object" || typeof returned === "function") &&
    typeof (returned as { then?: unknown }).then === "function"
  ) {
    // TypeScript permits async functions for () => void. Do not admit their work.
    void Promise.resolve(returned).catch(() => undefined);
    throw new TypeError("assertBeforeMutation must be synchronous");
  }
}

export function composeMutationAssertions(
  defaultAssertion?: () => void,
  callAssertion?: () => void,
): (() => void) | undefined {
  if (!defaultAssertion && !callAssertion) return undefined;
  return () => {
    try {
      assertSynchronous(defaultAssertion?.());
      assertSynchronous(callAssertion?.());
    } catch (error) {
      throw new MutationAuthorityError(error);
    }
  };
}

export function rethrowMutationAuthorityError(error: unknown): never {
  if (error instanceof MutationAuthorityError) throw error.rejection;
  // Cleanup failures and indeterminate publication receipts must retain their context.
  throw error;
}
