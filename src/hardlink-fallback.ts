// These refusals leave the destination uncreated. EEXIST is deliberately excluded.
const HARDLINK_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

export function isHardlinkFallbackError(error: unknown): boolean {
  return HARDLINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}
