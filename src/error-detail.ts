import os from "node:os";
import path from "node:path";

const UNSAFE_ERROR_DETAIL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export function formatErrorDetail(value: string): string {
  return value.replace(UNSAFE_ERROR_DETAIL_CHARACTERS, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function shortPath(value: string): string {
  const home = os.homedir();
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  const shortened = value === home ? "~"
    : value.startsWith(prefix) ? `~${path.sep}${value.slice(prefix.length)}` : value;
  return formatErrorDetail(shortened);
}
