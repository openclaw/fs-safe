import fs from "node:fs";
import path from "node:path";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/secure-temp-root";

const base = process.argv[2];
const umask = Number(process.argv[3]);
const preferredDir = path.join(base, "preferred");
const fallback = path.join(base, `fixture-${process.getuid()}`);
fs.mkdirSync(fallback, { mode: 0o700 });
fs.chmodSync(fallback, 0o700);
let pathnameChmods = 0;
const chmod = fs.chmodSync;
fs.chmodSync = (...args) => { pathnameChmods++; return chmod(...args); };
const previous = process.umask(umask);
try {
  const selected = resolveSecureTempRoot({ preferredDir, fallbackPrefix: "fixture", tmpdir: () => base, warn() {} });
  const preferredMode = fs.lstatSync(preferredDir).mode & 0o777;
  const stat = fs.lstatSync(selected);
  fs.accessSync(selected, fs.constants.W_OK | fs.constants.X_OK);
  console.log(JSON.stringify({
    pathnameChmods, preferredMode, usedFallback: selected === fallback,
    returnedSafe: stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o022) === 0,
  }));
} finally {
  process.umask(previous);
  fs.chmodSync = chmod;
  // Test cleanup only: the resolver deliberately leaves an unpinnable child.
  if (fs.existsSync(preferredDir)) chmod(preferredDir, 0o700);
}
