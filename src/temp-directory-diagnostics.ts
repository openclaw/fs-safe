export function tempDirectoryMode(mode: number | bigint): string {
  return (typeof mode === "bigint" ? mode & 0o7777n : mode & 0o7777).toString(8).padStart(4, "0");
}

export function privateTempDirectoryFix(uid: number | undefined): string {
  return `use a real private directory${uid === undefined ? "" : ` owned by uid ${uid}`} with mode 0700 under trusted ancestors (or use resolveSecureTempRoot()); do not chmod a shared temp directory to 0700`;
}

type TempDirectoryStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid?: number | bigint;
  mode?: number | bigint;
};

// Called only after failed admission; diagnostics never authorize repair.
export function secureTempDirectoryFailure(
  stat: TempDirectoryStat,
  uid: number | undefined,
  windows: boolean,
): string {
  if (stat.isSymbolicLink()) return "is a symbolic link; choose a real directory, not a symlink";
  if (!stat.isDirectory()) return "is not a directory; choose a real directory";
  if (!windows && uid !== undefined) {
    if (stat.uid !== undefined && stat.uid !== uid && stat.uid !== BigInt(uid)) {
      return `has owner uid ${stat.uid}, expected uid ${uid}; ${privateTempDirectoryFix(uid)}`;
    }
    const mode = stat.mode;
    if (mode !== undefined) {
      if ((typeof mode === "number" && (!Number.isSafeInteger(mode) || mode < 0)) ||
          (typeof mode === "bigint" && mode < 0n)) {
        return `has invalid mode bits; ${privateTempDirectoryFix(uid)}`;
      }
      if (typeof mode === "bigint" ? (mode & 0o022n) !== 0n : (mode & 0o022) !== 0) {
        return `has group/world-writable mode ${tempDirectoryMode(mode)} (a sticky bit does not make a private root safe); ${privateTempDirectoryFix(uid)}`;
      }
    }
  }
  return `directory identity, permissions, or write/search access could not be verified; ${privateTempDirectoryFix(uid)}`;
}
