export function normalizeMaxBytes(
  value: number | undefined,
  options: { defaultValue?: number; label?: string } = {},
): number | undefined {
  const selected = value === undefined ? options.defaultValue : value;
  if (selected === undefined || selected === Number.POSITIVE_INFINITY) return selected;
  if (!Number.isSafeInteger(selected) || selected < 0) {
    throw new RangeError(
      `${options.label ?? "maxBytes"} must be a non-negative safe integer or Infinity`,
    );
  }
  return selected;
}
