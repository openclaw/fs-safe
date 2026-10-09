import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipRecords } from "../../test/helpers/zip-records.ts";

const directory = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: producers.mjs <existing-corpus-directory>");
const manifestFile = path.join(directory, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
const scratch = await fs.mkdtemp(path.join(tmpdir(), "zip-producers-"));
const source = path.join(scratch, "source");
const producers = [];
await fs.mkdir(path.join(source, "nested"), { recursive: true });
await fs.mkdir(path.join(source, "empty"));
for (const name of ["payload", "café.txt", "雪.txt", "nested/child", "executable"]) {
  await fs.writeFile(path.join(source, name), `synthetic:${name}\n`);
}
await fs.chmod(path.join(source, "executable"), 0o755);
function command(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: source, timeout: 60000, maxBuffer: 1024 * 1024, ...options });
}
async function produce(label, executable, args, options) {
  const id = `producer-${process.platform}-${label}`;
  if (manifest.some(entry => entry.id === id)) throw new Error(`duplicate producer: ${id}`);
  const destination = path.join(directory, `${id}.zip`);
  try {
    command(executable, args(destination), typeof options === "function" ? options(destination) : options);
    const bytes = await fs.readFile(destination);
    if (!bytes.length) throw new Error("producer returned empty archive");
    manifest.push({ id, producer: label, platform: process.platform, bytes: bytes.length });
    producers.push({ id, executable, result: "generated", bytes: bytes.length });
  } catch (error) {
    producers.push({ id, executable, result: error.code === "ENOENT" ? "unavailable" : "failed", code: error.code ?? error.status ?? null });
  }
}
function compressedZip(body, method, compressed) {
  const base = zipRecords([{ name: "payload", body }]);
  const central = base.indexOf(Buffer.from("PK\x01\x02"));
  const local = Buffer.from(base.subarray(0, 37));
  const tail = Buffer.from(base.subarray(central));
  local.writeUInt16LE(method, 8); local.writeUInt32LE(compressed.length, 18);
  tail.writeUInt16LE(method, 10); tail.writeUInt32LE(compressed.length, 20);
  tail.writeUInt32LE(local.length + compressed.length, tail.length - 6);
  return Buffer.concat([local, compressed, tail]);
}
try {
  const python = process.platform === "win32" ? "python" : "python3";
  for (const [label, method] of [["stored", "ZIP_STORED"], ["deflate", "ZIP_DEFLATED"], ["bzip2", "ZIP_BZIP2"]]) {
    await produce(`python-${label}`, python, destination => ["-c", `import pathlib,sys,zipfile\nsrc=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2], 'w', compression=zipfile.${method}) as z:\n for p in sorted(src.rglob('*')): z.write(p,p.relative_to(src).as_posix())\n`, source, destination]);
  }
  await produce("python-descriptor", python, destination => ["-c", "import sys,zipfile,io\nclass Stream(io.BytesIO):\n def seekable(self): return False\n def seek(self,*args): raise io.UnsupportedOperation()\ns=Stream()\nwith zipfile.ZipFile(s,'w',compression=zipfile.ZIP_DEFLATED) as z: z.writestr('payload',b'synthetic descriptor')\nopen(sys.argv[1],'wb').write(s.getvalue())", destination]);
  await produce("java-jar", "jar", destination => ["--create", "--file", destination, "-C", source, "."]);
  for (const executable of ["7zz", "7z"]) {
    await produce(`${executable}-deflate`, executable, destination => ["a", "-tzip", "-mm=Deflate", destination, "."]);
    await produce(`${executable}-bzip2`, executable, destination => ["a", "-tzip", "-mm=BZip2", destination, "."]);
  }
  if (process.platform !== "win32") {
    await produce("infozip", "zip", destination => ["-r", destination, "."]);
    await produce("infozip-x", "zip", destination => ["-X", "-r", destination, "."]);
    await produce("infozip-encrypted", "zip", destination => ["-P", "synthetic-test-password", destination, "payload"]);
    await produce("libarchive", process.platform === "darwin" ? "/usr/bin/tar" : "bsdtar", destination => ["--format", "zip", "-cf", destination, "."]);
    for (const [name, target] of [["relative-link", "payload"], ["absolute-link", "/zip9-escape"], ["escaping-link", "../escape"]]) await fs.symlink(target, path.join(source, name));
    await produce("infozip-symlinks", "zip", destination => ["-y", "-r", destination, "."]);
    for (const name of ["relative-link", "absolute-link", "escaping-link"]) await fs.unlink(path.join(source, name));
  }
  if (process.platform === "darwin") {
    command("/usr/bin/xattr", ["-w", "com.example.fs-safe-zip-test", "synthetic", path.join(source, "payload")]);
    await produce("ditto-appledouble", "/usr/bin/ditto", destination => ["-c", "-k", "--sequesterRsrc", "--keepParent", source, destination]);
  }
  if (process.platform === "win32") {
    await produce("powershell-compress-archive", "powershell.exe", () => ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:FS_SAFE_ZIP_SOURCE -DestinationPath $env:FS_SAFE_ZIP_DEST"],
      destination => ({ env: { ...process.env, FS_SAFE_ZIP_SOURCE: source, FS_SAFE_ZIP_DEST: destination } }));
  }
  try {
    const body = "synthetic:zstd\n";
    const compressed = command("zstd", ["--quiet", "--stdout"], { input: body });
    const bytes = compressedZip(body, 93, compressed);
    const id = `producer-${process.platform}-zstd-method93`;
    await fs.writeFile(path.join(directory, `${id}.zip`), bytes);
    manifest.push({ id, producer: "zstd-raw-frame-in-zip", platform: process.platform, bytes: bytes.length });
    producers.push({ id, executable: "zstd", result: "generated", bytes: bytes.length });
  } catch (error) {
    producers.push({ id: "zstd-method93", executable: "zstd", result: error.code === "ENOENT" ? "unavailable" : "failed", code: error.code ?? error.status ?? null });
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(path.join(directory, `producers-${process.platform}.json`), JSON.stringify(producers, null, 2) + "\n");
  console.log(JSON.stringify(producers));
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
