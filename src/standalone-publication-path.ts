import {
  anchorWindowsDriveRelativePath,
  assertNoWindowsPathAlias,
} from "./windows-path-alias.js";

export function admitStandalonePublicationPath(value: string, message?: string): string {
  const admittedPath = anchorWindowsDriveRelativePath(value);
  assertNoWindowsPathAlias(admittedPath, "filesystem", message);
  return admittedPath;
}
