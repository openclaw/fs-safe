/** Native stat identities are unsigned; Node BigIntStats preserves them as signed bits. */
export function statIdentityFromNative(value: bigint): bigint {
  return value <= 0x7fff_ffff_ffff_ffffn || process.versions.bun ? value : BigInt.asIntN(64, value);
}

export function isNativeStatIdentity(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= 0xffff_ffff_ffff_ffffn;
}
