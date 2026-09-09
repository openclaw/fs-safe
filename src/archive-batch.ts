import { ownExtractionDestinationMutation, recordExtractionBatchFailure, type ExtractionDeadline } from "./archive-deadline.js";

/** Admission stays sequential; no work escapes a drained batch, even on failure. */
export function createArchiveBatch(deadline?: ExtractionDeadline) {
  const pending: Array<() => Promise<void>> = [];
  const drain = async () => {
    if (!pending.length) return;
    const tasks = pending.splice(0);
    await ownExtractionDestinationMutation(deadline, async () => {
      let failed = false;
      let firstError: unknown;
      await Promise.allSettled(tasks.map(async (run) => {
        if (failed) return;
        try { await run(); }
        catch (error) {
          // Preserve observation order, even when an earlier entry fails later.
          if (!failed) {
            failed = true;
            firstError = error;
            recordExtractionBatchFailure(deadline, error);
          }
          throw error;
        }
      }));
      if (failed) throw firstError;
    });
  };
  return {
    async add(run: () => Promise<void>) {
      pending.push(run);
      if (pending.length === 8) await drain();
    },
    drain,
  };
}
