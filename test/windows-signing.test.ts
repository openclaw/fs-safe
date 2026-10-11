import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "tar";
import { prepareSigning, readSigningManifest, recordBuild, sha256, verifyWindowsPackage, windowsFiles, windowsSigner } from "../scripts/windows-signing.mjs";

const directories: string[] = [];
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "windows-signing-"));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function buildInputs(directory: string) {
  for (const { file } of windowsFiles) {
    writeFileSync(join(directory, file), `unsigned ${file}`);
    recordBuild(join(directory, file));
  }
  const reference = join(directory, "reference.exe");
  writeFileSync(reference, readFileSync(join(directory, "windows-security-helper.exe")));
  recordBuild(reference);
  return reference;
}

function signingProof() {
  return { version: 1, files: Object.fromEntries(windowsFiles.map(({ file }: { file: string }) => [file, {
    status: "Valid", subject: windowsSigner, timestampThumbprint: "1".repeat(40),
    unsignedSha256: sha256(`unsigned ${file}`), signedSha256: sha256(`signed ${file}`),
  }])) };
}

describe("Windows release signing", () => {
  it("binds inputs to build hashes and records the reproducible unsigned helper hash", () => {
    const directory = workspace();
    const reference = buildInputs(directory);
    prepareSigning(directory, reference);
    const hashes = JSON.parse(readFileSync(join(directory, "unsigned-windows-sha256.json"), "utf8"));
    expect(hashes["windows-security-helper.exe"]).toBe(sha256(readFileSync(reference)));
    writeFileSync(join(directory, windowsFiles[0].file), "substituted addon");
    expect(() => prepareSigning(directory, reference)).toThrow(/build SHA-256 mismatch/);
  });

  it("rejects helper builds that are individually hashed but not reproducible", () => {
    const directory = workspace();
    const reference = buildInputs(directory);
    writeFileSync(reference, "different helper build");
    recordBuild(reference);
    expect(() => prepareSigning(directory, reference)).toThrow(/unsigned helper differs/);
  });

  it.each(["missing", "unsigned", "wrong signer", "no timestamp", "unchanged", "bad hash"])("rejects invalid signing evidence: %s", kind => {
    const directory = workspace();
    const path = join(directory, "windows-signing.json");
    const proof = signingProof();
    const file = windowsFiles[0].file;
    if (kind === "missing") delete proof.files[file];
    if (kind === "unsigned") proof.files[file].status = "NotSigned";
    if (kind === "wrong signer") proof.files[file].subject = "CN=Someone else";
    if (kind === "no timestamp") proof.files[file].timestampThumbprint = "";
    if (kind === "unchanged") proof.files[file].signedSha256 = proof.files[file].unsignedSha256;
    if (kind === "bad hash") proof.files[file].signedSha256 = "bad";
    writeFileSync(path, JSON.stringify(proof));
    expect(() => readSigningManifest(path)).toThrow();
    expect(() => readSigningManifest(undefined)).toThrow(/requires --windows-signing-manifest/);
  });

  it.each(windowsFiles)("checks packed bytes for $package, including accidental unsigned rebuilds", async ({ file, package: name, packed }) => {
    const directory = workspace();
    const path = join(directory, "windows-signing.json");
    writeFileSync(path, JSON.stringify(signingProof()));
    const proof = readSigningManifest(path);
    const binary = join(directory, "package", packed);
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, `signed ${file}`);
    const tarball = join(directory, "package.tgz");
    await create({ cwd: directory, file: tarball, gzip: true }, [`package/${packed}`]);
    await expect(verifyWindowsPackage(proof, name, tarball)).resolves.toBeUndefined();
    writeFileSync(binary, `unsigned ${file}`);
    await create({ cwd: directory, file: tarball, gzip: true }, [`package/${packed}`]);
    await expect(verifyWindowsPackage(proof, name, tarball)).rejects.toThrow(/packed bytes differ/);
    writeFileSync(join(directory, "package.json"), "{}");
    await create({ cwd: directory, file: tarball, gzip: true }, ["package.json"]);
    await expect(verifyWindowsPackage(proof, name, tarball)).rejects.toThrow(/exactly one packed binary/);
  });
});
