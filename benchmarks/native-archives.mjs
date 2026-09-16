import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nativeArchiveFixtures } from "./native-archive-fixtures.mjs";

export function registerNativeArchives({ api, workspace, register, native }) {
  for (const fixture of nativeArchiveFixtures) {
    const names = fixture.members === 1 && fixture.memberBytes > 128
      ? ["payload.bin"] : Array.from({ length: fixture.members }, (_, index) => `entry-${index}`);
    const payload = native ? Buffer.alloc(fixture.memberBytes, fixture.payloadByte) : undefined;
    for (const codec of ["zstd", "bzip2"]) {
      const label = `native-codec/${codec}/${fixture.name}`;
      const bytes = Buffer.from(fixture[codec], "base64");
      assert.equal(bytes.length, fixture.compressedBytes[codec]);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.compressedSha256[codec]);
      const archivePath = path.join(workspace, `${fixture.name}.tar.${codec === "zstd" ? "zst" : "bz2"}`);
      const destination = path.join(workspace, `native-codec-${codec}-${fixture.name}`);
      if (native) {
        fs.writeFileSync(archivePath, bytes);
        fs.mkdirSync(destination);
      }
      const options = {
        divisor: 100,
        skip: native ? undefined : "zstd/bzip2 archives require the native binding",
        workloadDetails: {
          codec, members: fixture.members, memberBytes: fixture.memberBytes,
          compressedBytes: bytes.length, compressedSha256: fixture.compressedSha256[codec],
          rawTarBytes: fixture.rawTarBytes, rawTarSha256: fixture.rawTarSha256,
          payload: "constant byte; compressible",
        },
      };
      register(`extractArchive/${label}`, () => api.extractArchive({
        archivePath, destDir: destination, timeoutMs: 30_000,
      }), {
        ...options,
        before: () => assert.deepEqual(fs.readdirSync(destination), []),
        verify: () => {
          assert.deepEqual(fs.readdirSync(destination).sort(), [...names].sort());
          for (const name of names) assert.ok(fs.readFileSync(path.join(destination, name)).equals(payload));
        },
        after: () => {
          for (const name of names) fs.rmSync(path.join(destination, name), { force: true });
        },
      });
      // The public API takes a pathname, then retains private input bytes for
      // native admission and selected-member replay through Cursor readers.
      register(`readArchiveEntry/${label}`, () => api.readArchiveEntry(archivePath, names.at(-1), {
        maxBytes: fixture.memberBytes,
      }), { ...options, verify: result => assert.ok(result.equals(payload)) });
    }
  }
}
