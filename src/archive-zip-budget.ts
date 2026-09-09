import { createByteBudgetTracker, type ResolvedArchiveExtractLimits } from "./archive-limits.js";

export function createZipExtractionBudget(limits: ResolvedArchiveExtractLimits) {
  const total = createByteBudgetTracker(limits);
  return (declaredSize: number): ((bytes: number) => void) => {
    total.startEntry();
    total.addEntrySize(declaredSize);
    const entry = createByteBudgetTracker(limits);
    let remaining = declaredSize;
    return (bytes) => {
      // Keep actual-byte checks before integrity checking; a lying size must not
      // bypass either limit while concurrent streams consume their reservations.
      entry.addBytes(bytes);
      const excess = Math.max(0, bytes - remaining);
      remaining = Math.max(0, remaining - bytes);
      if (excess) {
        total.startEntry();
        total.addBytes(excess);
      }
    };
  };
}
