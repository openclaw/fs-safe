const ByteView = Uint8Array;
const typedArray = Object.getPrototypeOf(ByteView.prototype) as object;
const viewLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const viewBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;

/** Snapshot intrinsic view bounds without copying the borrowed payload. */
export function snapshotByteView(bytes: Uint8Array): Uint8Array {
  const length = Reflect.apply(viewLength, bytes, []) as number;
  // Preserve empty, detached, and out-of-bounds views as zero-byte inputs.
  if (length === 0) return new ByteView(0);
  return new ByteView(Reflect.apply(viewBuffer, bytes, []), Reflect.apply(viewOffset, bytes, []), length);
}
