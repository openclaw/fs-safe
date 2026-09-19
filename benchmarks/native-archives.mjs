import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  nativeArchiveFixtures,
  nativeArchiveRefillFixture,
} from "./native-archive-fixtures.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function materializeRefillFixture(fixture, codec) {
  const block = Buffer.allocUnsafe(fixture.payloadBlockBytes);
  const seed = Buffer.from(fixture.payloadSeed, "utf8");
  for (let offset = 0, counter = 0; offset < block.length; counter += 1) {
    const counterBytes = Buffer.allocUnsafe(4);
    counterBytes.writeUInt32BE(counter);
    const digest = createHash("sha256").update(seed).update(counterBytes).digest();
    offset += digest.copy(block, offset);
  }
  assert.equal(sha256(block), fixture.payloadBlockSha256);
  assert.equal(fixture.memberBytes, fixture.payloadBlockBytes * fixture.payloadBlockRepeats);
  assert.equal(fixture.frameCount, fixture.payloadBlockRepeats + 2);

  const payload = Buffer.allocUnsafe(fixture.memberBytes);
  for (let offset = 0; offset < payload.length; offset += block.length) block.copy(payload, offset);
  assert.equal(sha256(payload), fixture.payloadSha256);

  const header = Buffer.from(fixture.rawHeaderBase64, "base64");
  assert.equal(sha256(header), fixture.rawHeaderSha256);
  const trailer = Buffer.alloc(fixture.rawTrailerBytes);
  assert.equal(sha256(trailer), fixture.rawTrailerSha256);
  const rawTar = Buffer.concat([header, payload, trailer], fixture.rawTarBytes);
  assert.equal(rawTar.length, fixture.rawTarBytes);
  assert.equal(sha256(rawTar), fixture.rawTarSha256);

  const codecFixture = fixture.codecs[codec];
  const decoded = { header, "payload-block": block, trailer };
  const frames = Object.fromEntries(Object.entries(codecFixture.components).map(([name, component]) => {
    assert.equal(component.decodedBytes, decoded[name].length);
    assert.equal(component.decodedSha256, sha256(decoded[name]));
    const compressed = Buffer.from(component.base64, "base64");
    assert.equal(compressed.length, component.compressedBytes);
    assert.equal(sha256(compressed), component.compressedSha256);
    return [name, compressed];
  }));
  const archive = Buffer.concat([
    frames.header,
    ...Array.from({ length: fixture.payloadBlockRepeats }, () => frames["payload-block"]),
    frames.trailer,
  ], codecFixture.assembledBytes);
  assert.equal(archive.length, codecFixture.assembledBytes);
  assert.equal(sha256(archive), codecFixture.assembledSha256);
  return { archive, payload };
}

export function registerNativeArchives({ api, workspace, register }) {
  for (const fixture of nativeArchiveFixtures) {
    const names = fixture.members === 1 && fixture.memberBytes > 128
      ? ["payload.bin"] : Array.from({ length: fixture.members }, (_, index) => `entry-${index}`);
    const payload = Buffer.alloc(fixture.memberBytes, fixture.payloadByte);
    for (const codec of ["zstd", "bzip2"]) {
      const label = `native-codec/${codec}/${fixture.name}`;
      const bytes = Buffer.from(fixture[codec], "base64");
      assert.equal(bytes.length, fixture.compressedBytes[codec]);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.compressedSha256[codec]);
      const archivePath = path.join(workspace, `${fixture.name}.tar.${codec === "zstd" ? "zst" : "bz2"}`);
      const destination = path.join(workspace, `native-codec-${codec}-${fixture.name}`);
      fs.writeFileSync(archivePath, bytes);
      fs.mkdirSync(destination);
      const options = {
        divisor: 100,
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

  const fixture = nativeArchiveRefillFixture;
  for (const codec of ["zstd", "bzip2"]) {
    const label = `native-codec/${codec}/${fixture.name}`;
    const materialized = materializeRefillFixture(fixture, codec);
    const archivePath = path.join(workspace, `${fixture.name}.tar.${codec === "zstd" ? "zst" : "bz2"}`);
    const destination = path.join(workspace, `native-codec-${codec}-${fixture.name}`);
    fs.writeFileSync(archivePath, materialized.archive);
    fs.mkdirSync(destination);
    const codecFixture = fixture.codecs[codec];
    const options = {
      divisor: 100,
      workloadDetails: {
        codec, members: fixture.members, memberBytes: fixture.memberBytes,
        compressedBytes: codecFixture.assembledBytes,
        compressedSha256: codecFixture.assembledSha256,
        rawTarBytes: fixture.rawTarBytes, rawTarSha256: fixture.rawTarSha256,
        frames: fixture.frameCount,
        payloadBlockBytes: fixture.payloadBlockBytes,
        payloadBlockRepeats: fixture.payloadBlockRepeats,
        payloadBlockSha256: fixture.payloadBlockSha256,
        payloadSha256: fixture.payloadSha256,
        payload: "deterministic SHA-256 counter block; one compressed block frame replayed",
        fixtureGeneratorCommit: fixture.provenance.generatorCommit,
        fixtureGeneratorRunId: fixture.provenance.runId,
      },
    };
    register(`extractArchive/${label}`, () => api.extractArchive({
      archivePath, destDir: destination, timeoutMs: 30_000,
    }), {
      ...options,
      before: () => assert.deepEqual(fs.readdirSync(destination), []),
      verify: () => {
        assert.deepEqual(fs.readdirSync(destination), [fixture.entryName]);
        assert.ok(fs.readFileSync(path.join(destination, fixture.entryName)).equals(materialized.payload));
      },
      after: () => fs.rmSync(path.join(destination, fixture.entryName), { force: true }),
    });
    register(`readArchiveEntry/${label}`, () => api.readArchiveEntry(archivePath, fixture.entryName, {
      maxBytes: fixture.memberBytes,
    }), { ...options, verify: result => assert.ok(result.equals(materialized.payload)) });
  }
}
