export function normalizeMaxBytes(
  value: number | undefined,
  options: { defaultValue?: number } = {},
): number | undefined {
  const selected = value === undefined ? options.defaultValue : value;
  if (selected === undefined || selected === Number.POSITIVE_INFINITY) return selected;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError(
      "maxBytes must be a non-negative safe integer or Infinity",
    );
  }
  return selected;
}

export function normalizeTraversalBudget(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
