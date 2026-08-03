import os from "node:os";
import { formatErrorDetail } from "./error-detail.js";

export function shortPath(value: string): string {
  const home = os.homedir();
  const shortened = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return formatErrorDetail(shortened);
}
