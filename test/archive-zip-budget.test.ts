import { expect, it } from "vitest";
import { createZipExtractionBudget } from "../src/archive-zip-budget.js";
import { resolveExtractLimits } from "../src/archive-limits.js";

it("reserves exact ZIP bytes before dispatch without sharing per-entry counters", () => {
  const reserve = createZipExtractionBudget(resolveExtractLimits({ maxEntryBytes: 3, maxExtractedBytes: 24 }));
  const writes = Array.from({ length: 8 }, () => reserve(3));
  for (const write of writes) write(1);
  for (const write of writes.toReversed()) write(2);
  expect(() => reserve(1)).toThrow(expect.objectContaining({ code: "archive-extracted-size-exceeds-limit" }));
});
it("retains the per-entry limit during interleaved streams", () => {
  const reserve = createZipExtractionBudget(resolveExtractLimits({ maxEntryBytes: 3, maxExtractedBytes: 24 }));
  const first = reserve(3);
  const second = reserve(3);
  first(2); second(2);
  expect(() => first(2)).toThrow(expect.objectContaining({ code: "archive-entry-extracted-size-exceeds-limit" }));
});
it("charges undeclared bytes in addition to all outstanding reservations", () => {
  const reserve = createZipExtractionBudget(resolveExtractLimits({ maxEntryBytes: 10, maxExtractedBytes: 8 }));
  const first = reserve(3);
  const second = reserve(3);
  first(4); second(4);
  expect(() => first(1)).toThrow(expect.objectContaining({ code: "archive-extracted-size-exceeds-limit" }));
});
