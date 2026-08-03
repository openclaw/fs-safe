import { ArchiveSecurityError } from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";

export type ArchiveEntryKind = "file" | "directory" | "symlink" | "other";
export type ArchiveEntryModePolicy = "clamp" | "preserve";
export type ArchiveFilteredEntryPolicy = "reject-archive" | "skip-entry";
export type ArchiveEntryFilter = (entry: {
  path: string;
  kind: ArchiveEntryKind;
  size: number;
}) => "extract" | "skip";

export function archiveEntryKindFromTarType(type: string): ArchiveEntryKind {
  if (type === "Directory" || type === "GNUDumpDir") return "directory";
  if (type === "File" || type === "OldFile" || type === "ContiguousFile") return "file";
  if (type === "SymbolicLink" || type === "Link") return "symlink";
  return "other";
}

export function resolveArchiveEntryMode(params: {
  kind: "file" | "directory";
  archivedMode?: number;
  policy?: ArchiveEntryModePolicy;
}): number {
  const archivedMode = (params.archivedMode ?? 0) & 0o777;
  if (params.policy === "preserve") {
    return archivedMode || (params.kind === "directory" ? 0o755 : 0o644);
  }
  if (params.kind === "directory") {
    return 0o755;
  }
  return archivedMode & 0o100 ? 0o755 : 0o644;
}

export function shouldExtractArchiveEntry(params: {
  filter?: ArchiveEntryFilter;
  onFiltered?: ArchiveFilteredEntryPolicy;
  entry: Parameters<ArchiveEntryFilter>[0];
}): boolean {
  if (!params.filter || params.filter(params.entry) === "extract") {
    return true;
  }
  if ((params.onFiltered ?? "reject-archive") === "reject-archive") {
    throw new ArchiveSecurityError(
      "entry-filtered",
      `archive entry rejected by filter: ${formatErrorDetail(params.entry.path)}`,
    );
  }
  return false;
}
