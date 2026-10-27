import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { create as createTar } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { verifyPackedInput } from "../scripts/check-release-packages.mjs";
import { packageProofSource } from "../scripts/consumer-proof-metadata.mjs";

const directories: string[] = [];
const source = { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false };
const host = "win32-x64-msvc";
const nativePkg = {
  name: "@openclaw/fs-safe-win32-x64-msvc", version: "1.0.0", main: "fs-safe-native.node",
  os: ["win32"], cpu: ["x64"],
};
const rootPkg = {
  name: "@openclaw/fs-safe", version: "1.0.0", type: "module",
  optionalDependencies: { [nativePkg.name]: nativePkg.version },
};
const rootFiles: Record<string, string> = {
  "dist/index.js": "export const fixture = true;\n",
  "dist/index.d.ts": "export declare const fixture: boolean;\n",
  "dist/windows-security-helper.exe": "synthetic non-executable metadata fixture",
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture({ files = rootFiles, nativeMetadata = nativePkg,
  nativeFiles = { "fs-safe-native.node": "synthetic non-executable binding fixture" } as Record<string, string> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fs-safe-packed-reuse-"));
  directories.push(directory);
  const manifest = [];
  for (const [pkg, payload] of [
    [nativeMetadata, nativeFiles],
    [rootPkg, files],
  ] as const) {
    const staging = join(directory, pkg.name.split("/").at(-1)!);
    await mkdir(staging);
    const contents = { "package.json": JSON.stringify(pkg), ...payload };
    for (const [path, text] of Object.entries(contents)) {
      const file = join(staging, path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, text);
    }
    const filename = `${pkg.name.slice(1).replaceAll("/", "-")}-${pkg.version}.tgz`;
    await createTar({ cwd: staging, file: join(directory, filename), gzip: true, portable: true, prefix: "package/" }, Object.keys(contents));
    const bytes = await readFile(join(directory, filename));
    manifest.push({
      name: pkg.name, version: pkg.version, filename, size: bytes.length,
      unpackedSize: Object.values(contents).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }
  const receipt = { schema: 1, source: { ...source }, host, manifestSha256: "" };
  async function save() {
    const bytes = JSON.stringify(manifest);
    receipt.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "manifest.json"), bytes);
    await writeFile(join(directory, "package-build-proof.json"), JSON.stringify(receipt));
  }
  await save();
  return { directory, manifest, receipt, save, verify: (actualSource = source) =>
    verifyPackedInput({ directory, rootPkg, hostPkg: nativePkg, source: actualSource, host }) };
}

it("accepts complete source-bound root and host tarballs without repacking", async () => {
  const input = await fixture();
  await expect(input.verify()).resolves.toEqual(input.manifest);
});

it("keeps actual Git source identity clean when producing and restoring the workflow bundle", async () => {
  const workflow = (await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"))
    .replace(/\r\n?/gu, "\n");
  const producer = workflow.match(/^  package-smoke-build:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];
  const consumer = workflow.match(/^  package-smoke:\n((?: {4,}[^\n]*\n|\n)*)/mu)?.[1];
  const output = producer?.match(/run: pnpm package:collect --allow-host-only --pack-only --output (\S+)/u)?.[1];
  const restored = consumer?.match(/run: pnpm package:smoke --packed-input (\S+)/u)?.[1];
  expect(output).toBeDefined();
  expect(restored).toBe(output);
  expect(producer).toContain(`            ${output}/\n`);

  const directory = await mkdtemp(join(tmpdir(), "fs-safe-pack-source-"));
  directories.push(directory);
  const producerRoot = join(directory, "producer");
  const consumerRoot = join(directory, "consumer");
  await mkdir(producerRoot);
  await copyFile(new URL("../.gitignore", import.meta.url), join(producerRoot, ".gitignore"));
  await writeFile(join(producerRoot, "source.txt"), "source identity fixture\n");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: "pipe", timeout: 10_000,
  });
  git(producerRoot, ["init"]);
  git(producerRoot, ["add", ".gitignore", "source.txt"]);
  git(producerRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "source fixture"]);
  const actualSource = packageProofSource(producerRoot);
  if ("unavailable" in actualSource) throw new Error("Git fixture source must be available");
  expect(actualSource.dirty).toBe(false);
  vi.stubEnv("FS_SAFE_EXPECTED_SOURCE_COMMIT", actualSource.commit);
  const input = await fixture();
  input.receipt.source = actualSource;
  await input.save();
  const restoreBundle = async (root: string, relative: string) => {
    const bundle = join(root, relative);
    await mkdir(bundle);
    for (const filename of ["manifest.json", "package-build-proof.json", ...input.manifest.map(entry => entry.filename)]) {
      await copyFile(join(input.directory, filename), join(bundle, filename));
    }
    return bundle;
  };
  const verify = (bundle: string, root: string) => verifyPackedInput({ directory: bundle,
    rootPkg, hostPkg: nativePkg, source: packageProofSource(root), host });
  const producerBundle = await restoreBundle(producerRoot, output!);
  expect(packageProofSource(producerRoot)).toEqual(actualSource);
  await expect(verify(producerBundle, producerRoot)).resolves.toEqual(input.manifest);
  git(directory, ["clone", "--local", "--no-hardlinks", producerRoot, consumerRoot]);
  expect(packageProofSource(consumerRoot)).toEqual(actualSource);
  const consumerBundle = await restoreBundle(consumerRoot, restored!);
  expect(packageProofSource(consumerRoot)).toEqual(actualSource);
  await expect(verify(consumerBundle, consumerRoot)).resolves.toEqual(input.manifest);

  await writeFile(join(consumerRoot, "unknown-output.json"), "{}\n");
  expect(packageProofSource(consumerRoot)).toEqual({ ...actualSource, dirty: true });
  await expect(verify(consumerBundle, consumerRoot)).rejects.toThrow("clean source checkout");
});

it.each(["commit", "tree", "dirty"] as const)("rejects a different or dirty consumer %s", async key => {
  const input = await fixture();
  const actual = { ...source, [key]: key === "dirty" ? true : "c".repeat(40) };
  await expect(input.verify(actual as typeof source)).rejects.toThrow();
});

it.each(["schema", "host", "manifestSha256"] as const)("rejects a mismatched producer %s", async key => {
  const input = await fixture();
  await writeFile(join(input.directory, "package-build-proof.json"), JSON.stringify({ ...input.receipt, [key]: "wrong" }));
  await expect(input.verify()).rejects.toThrow("binding differs");
});

it("requires the workflow's expected source, not only agreement with a receipt", async () => {
  const input = await fixture();
  vi.stubEnv("FS_SAFE_EXPECTED_SOURCE_COMMIT", "c".repeat(40));
  await expect(input.verify()).rejects.toThrow();
});

it.each(["manifest.json", "package-build-proof.json", "openclaw-fs-safe-1.0.0.tgz"])("fails missing %s without a pack fallback", async file => {
  const input = await fixture();
  await rm(join(input.directory, file));
  await expect(input.verify()).rejects.toThrow();
});

it.each(["missing", "extra", "duplicate"])("rejects a %s artifact set", async mode => {
  const input = await fixture();
  if (mode === "missing") input.manifest.pop();
  if (mode === "extra") input.manifest.push({ ...input.manifest[0]! });
  if (mode === "duplicate") input.manifest[1] = { ...input.manifest[0]! };
  await input.save();
  await expect(input.verify()).rejects.toThrow();
});

it.each([
  ["name", "wrong-package"], ["version", "2.0.0"], ["filename", "../outside.tgz"], ["filename", "..\\outside.tgz"],
  ["filename", "/outside.tgz"], ["integrity", "sha512-wrong"], ["size", 1], ["unpackedSize", 1],
] as const)("rejects incorrect artifact %s=%s", async (key, value) => {
  const input = await fixture();
  Object.assign(input.manifest[0]!, { [key]: value });
  await input.save();
  await expect(input.verify()).rejects.toThrow();
});

it("rejects modified bytes even when the filename and source are unchanged", async () => {
  const input = await fixture();
  const file = join(input.directory, input.manifest[0]!.filename);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  await writeFile(file, bytes);
  await expect(input.verify()).rejects.toThrow("artifact integrity");
});

it("rejects a truncated archive body even when its outer integrity and receipt are resealed", async () => {
  const input = await fixture();
  const entry = input.manifest[0]!;
  const file = join(input.directory, entry.filename);
  const archive = gunzipSync(await readFile(file));
  let truncated: Buffer | undefined;
  for (let offset = 0; offset < archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/u, "").trim(), 8);
    if (name === "package/fs-safe-native.node") {
      truncated = gzipSync(archive.subarray(0, offset + 512 + size - 1));
      break;
    }
    if (!name) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(truncated).toBeDefined();
  await writeFile(file, truncated!);
  entry.size = truncated!.length;
  entry.integrity = `sha512-${createHash("sha512").update(truncated!).digest("base64")}`;
  await input.save();
  await expect(input.verify()).rejects.toThrow("TAR_BAD_ARCHIVE: Truncated input");
});

it.skipIf(process.platform === "win32")("rejects tarball symlinks", async () => {
  const input = await fixture();
  const file = join(input.directory, input.manifest[0]!.filename);
  const outside = join(input.directory, "outside.tgz");
  await writeFile(outside, await readFile(file));
  await rm(file);
  await symlink(outside, file);
  await expect(input.verify()).rejects.toThrow("regular file");
});

it.each(["os", "cpu"] as const)("checks packed native %s metadata, not only tarball integrity", async key => {
  const input = await fixture({ nativeMetadata: { ...nativePkg, [key]: ["wrong"] } });
  await expect(input.verify()).rejects.toThrow("metadata differs");
});

it.each([{}, { "fs-safe-native.node": "fixture", "extra.js": "not allowed" }])("requires the exact native payload %j", async nativeFiles => {
  const input = await fixture({ nativeFiles });
  await expect(input.verify()).rejects.toThrow();
});

it.each(["dist/index.js", "dist/index.d.ts", "dist/windows-security-helper.exe"])("requires packed %s", async missing => {
  const files = { ...rootFiles };
  delete files[missing];
  const input = await fixture({ files });
  await expect(input.verify()).rejects.toThrow("missing");
});

it("retains runtime import closure validation against archive bytes", async () => {
  const input = await fixture({ files: { ...rootFiles, "dist/index.js": "import './omitted.js';\n" } });
  await expect(input.verify()).rejects.toThrow("missing relative runtime files");
});

it("keeps native binaries outside the root tarball", async () => {
  const input = await fixture({ files: { ...rootFiles, "dist/host.node": "not permitted" } });
  await expect(input.verify()).rejects.toThrow("must not contain native binaries");
});

it.each([
  [["--allow-host-only", "--pack-only", "--packed-input", "fixture"], "mutually exclusive"],
  [["--pack-only"], "host-only collection"],
  [["--packed-input", "fixture"], "host-only collection"],
  [["--allow-host-only", "--packed-input", ""], "must not be empty"],
  [["--allow-host-only", "--packed-input", "fixture", "--windows-signing-manifest", "fixture.json"], "signed collection"],
  [["--unknown-collection-mode"], "ERR_PARSE_ARGS_UNKNOWN_OPTION"],
] as const)("rejects incompatible reuse arguments %j before packing", (args, message) => {
  try {
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../scripts/check-release-packages.mjs", import.meta.url)), ...args,
    ], { encoding: "utf8", stdio: "pipe", timeout: 10_000 });
    expect.fail("invalid collection arguments must fail");
  } catch (error) {
    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr: string }).stderr)).toContain(message);
  }
});
