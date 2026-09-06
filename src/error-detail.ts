import os from "node:os";

const UNSAFE_ERROR_DETAIL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;

export function formatErrorDetail(value: string): string {
  return value.replace(UNSAFE_ERROR_DETAIL_CHARACTERS, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export function shortPath(value: string): string {
  const home = os.homedir();
  const shortened = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return formatErrorDetail(shortened);
}
