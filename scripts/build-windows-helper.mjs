import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const project = "native/windows-security-helper/WindowsSecurityHelper.csproj";
const probe = spawnSync("dotnet", ["--version"], { cwd: root, encoding: "utf8" });
if (probe.error?.code === "ENOENT" && process.argv.includes("--if-available") && process.platform !== "win32") {
  const staged = new URL("../src/windows-security-helper.exe", import.meta.url);
  if (existsSync(staged)) {
    mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
    copyFileSync(staged, new URL("../dist/windows-security-helper.exe", import.meta.url));
  } else console.warn("Windows helper not built: install the .NET SDK pinned in global.json and run pnpm build:windows-helper before packing.");
} else {
  if (probe.error || probe.status !== 0) throw new Error("Windows helper requires the .NET SDK pinned in global.json; install it and run pnpm build:windows-helper", { cause: probe.error });
  const build = spawnSync("dotnet", ["build", project, "--configuration", "Release", "--nologo", "--verbosity", "minimal", "-p:RestoreLockedMode=true"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Windows helper build failed");
  mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
  const exe = new URL("../native/windows-security-helper/bin/Release/net40/windows-security-helper.exe", import.meta.url);
  for (const directory of ["src", "dist"]) copyFileSync(exe, new URL(`../${directory}/windows-security-helper.exe`, import.meta.url));
}
