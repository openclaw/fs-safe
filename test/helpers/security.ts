import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { FsSafeError } from "../../src/index.js";

export type TempLayout = {
  outside: string;
  outsideFile: string;
  root: string;
};

export const TRAVERSAL_PAYLOADS = [
  "../secret.txt",
  "../../secret.txt",
  "nested/../../secret.txt",
  "nested/../../../secret.txt",
  "./../secret.txt",
  "nested/..//../secret.txt",
  "nested/%2e%2e/secret.txt",
  "%2e%2e/secret.txt",
  "%2e%2e%2fsecret.txt",
  "..%2fsecret.txt",
  "%252e%252e%252fsecret.txt",
  "..%00/secret.txt",
  "..\\secret.txt",
  "nested\\..\\..\\secret.txt",
  "C:\\Windows\\win.ini",
  "\\\\server\\share\\secret.txt",
] as const;

export const LIST_TRAVERSAL_PAYLOADS = [
  "..",
  "../",
  "../../",
  "nested/../..",
  "nested/../../outside",
  "%2e%2e",
  "%2e%2e%2f",
  "..\\",
  "C:\\Windows",
  "\\\\server\\share",
] as const;

export const ESCAPING_WRITE_PAYLOADS = [
  "../pwned.txt",
  "../../pwned.txt",
  "nested/../../pwned.txt",
  "nested/../../../pwned.txt",
  "./../pwned.txt",
  "nested/..//../pwned.txt",
] as const;

export const LITERAL_SUSPICIOUS_WRITE_PAYLOADS = [
  "nested/%2e%2e/pwned.txt",
  "%2e%2e/pwned.txt",
  "%2e%2e%2fpwned.txt",
  "%252e%252e%252fpwned.txt",
  // ".." prefix without an actual separator: a single literal filename
  // ("..%2fpwned.txt") or two literal segments ("..%00", "pwned.txt") that
  // resolve fully inside root. Accepted on both platforms.
  "..%2fpwned.txt",
  "..%00/pwned.txt",
] as const;

export const POSIX_LITERAL_SUSPICIOUS_WRITE_PAYLOADS = [
  "nested\\..\\..\\pwned.txt",
  "C:\\Windows\\win.ini",
  "\\\\server\\share\\pwned.txt",
  // "..\\" is a real traversal on Windows (separator) but a literal filename
  // on POSIX (where "\\" is a regular name character).
  "..\\pwned.txt",
] as const;

export const ESCAPING_DIRECTORY_PAYLOADS = [
  "..",
  "../",
  "../../",
  "nested/../..",
  "nested/../../outside",
] as const;

export const LITERAL_SUSPICIOUS_DIRECTORY_PAYLOADS = ["%2e%2e", "%2e%2e%2f"] as const;
export const SAFE_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS = ["..\\"] as const;

export const WINDOWS_REJECTED_SUSPICIOUS_DIRECTORY_PAYLOADS = [
  "C:\\Windows",
  "\\\\server\\share",
] as const;

export async function makeTempLayout(
  prefix: string,
  tempDirs: string[],
): Promise<TempLayout> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-root-`));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-outside-`));
  tempDirs.push(root, outside);
  const outsideFile = path.join(outside, "secret.txt");
  await fsp.writeFile(outsideFile, "outside secret");
  return { outside, outsideFile, root };
}

export function expectFsSafeCode(
  error: unknown,
  codes: readonly string[],
  opts: { allowUnsupportedPlatformOnWindows?: boolean } = {},
): void {
  expect(error).toBeInstanceOf(FsSafeError);
  const accepted = process.platform === "win32" && opts.allowUnsupportedPlatformOnWindows
    ? [...codes, "unsupported-platform"]
    : codes;
  expect(accepted).toContain((error as FsSafeError).code);
}

export async function expectFsSafeError(
  promise: PromiseLike<unknown>,
  code: FsSafeError["code"],
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code });
}

export function expectFsSafeErrorSync(
  operation: () => unknown,
  code: FsSafeError["code"],
): void {
  let error: unknown;
  try {
    operation();
  } catch (reason) {
    error = reason;
  }
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code });
}

export function expectedFsSafeCode(code: string): string {
  return code;
}

export async function expectNoOutsideWrite(
  layout: TempLayout,
  expected = "outside secret",
): Promise<void> {
  await expect(fsp.readFile(layout.outsideFile, "utf8")).resolves.toBe(expected);
}
