const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [directory, canonical, device, inode] = process.argv.slice(2);
try { process.chdir(directory); } catch { process.exit(1); }
if (fs.realpathSync(".") !== canonical) process.exit(78);
const bound = fs.statSync(".", { bigint: true });
if (String(bound.dev) !== device || String(bound.ino) !== inode) process.exit(78);
const child = spawn("/usr/bin/tar", ["-czf", "-", "."], { stdio: ["ignore", "inherit", "inherit"] });
child.once("error", () => process.exit(1));
child.once("exit", (code) => process.exit(code ?? 1));
