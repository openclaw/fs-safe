type ObservedShiftResult<T> = {
  markedShifts: number[];
} & ({ ok: true; result: T } | { ok: false; error: unknown });

/** Install a plain, synchronous wrapper so test-framework spy internals cannot recurse through shift(). */
export function observeArrayShifts<T>(
  markerGroups: readonly (readonly string[])[],
  run: () => T,
): ObservedShiftResult<T> {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "shift");
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error("Array.prototype.shift descriptor is unavailable");
  }
  const originalShift = descriptor.value as (this: unknown[]) => unknown;
  const markedShifts = markerGroups.map(() => 0);
  Object.defineProperty(Array.prototype, "shift", {
    ...descriptor,
    value: function observedShift(this: unknown[]) {
      for (let index = 0; index < markerGroups.length; index++) {
        if (markerGroups[index]!.every(marker => this.includes(marker))) {
          markedShifts[index] = markedShifts[index]! + 1;
        }
      }
      return Reflect.apply(originalShift, this, []);
    },
  });
  try {
    return { ok: true, result: run(), markedShifts };
  } catch (error) {
    return { ok: false, error, markedShifts };
  } finally {
    Object.defineProperty(Array.prototype, "shift", descriptor);
  }
}
