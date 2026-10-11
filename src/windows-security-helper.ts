import { fileURLToPath } from "node:url";

export function windowsSecurityHelperPath(): string {
  return fileURLToPath(new URL("./windows-security-helper.exe", import.meta.url));
}

export function explainWindowsSecurityHelperFailure(error: Error): void {
  error.message += "; Windows security helper could not complete; rebuild with pnpm build:windows-helper or reinstall @openclaw/fs-safe";
}
