import { copyFileSync } from "node:fs";

export const WINDOWS_COMMAND_ASSETS = [
  "windows-move-bridge.cs",
  "windows-move-bridge.ps1",
];

export function copyWindowsCommandAssets() {
  for (const name of WINDOWS_COMMAND_ASSETS) {
    copyFileSync(new URL(`../src/${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
  }
}
