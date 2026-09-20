import assert from "node:assert/strict";
import JSZip from "jszip";

const ENTRY_COUNT = 2048;
const PAYLOAD_BYTES = 64;
const UTF8_FLAG = 0x800;

function payload(index) {
  return Buffer.from(`payload-${String(index).padStart(4, "0")}`.padEnd(PAYLOAD_BYTES, "."));
}

function verifyFixture(bytes, names, encoding) {
  const flags = encoding === "unflagged-ascii" ? 0 : UTF8_FLAG;
  const comment = Buffer.from(encoding === "flagged-ascii" ? "café" : "");
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0);
  assert.equal(bytes.readUInt16LE(end + 6), 0);
  assert.equal(bytes.readUInt16LE(end + 8), ENTRY_COUNT);
  assert.equal(bytes.readUInt16LE(end + 10), ENTRY_COUNT);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  const centralStart = bytes.readUInt32LE(end + 16);
  assert.equal(centralStart + bytes.readUInt32LE(end + 12), end);
  let central = centralStart;
  let local = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name);
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    assert.equal(bytes.readUInt16LE(central + 8), flags);
    assert.equal(bytes.readUInt16LE(central + 10), 0);
    assert.equal(bytes.readUInt32LE(central + 20), PAYLOAD_BYTES);
    assert.equal(bytes.readUInt32LE(central + 24), PAYLOAD_BYTES);
    assert.equal(bytes.readUInt32LE(central + 42), local);
    const centralNameLength = bytes.readUInt16LE(central + 28);
    const centralExtraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    assert.deepEqual(bytes.subarray(central + 46, central + 46 + centralNameLength), nameBytes);
    const commentStart = central + 46 + centralNameLength + centralExtraLength;
    assert.deepEqual(bytes.subarray(commentStart, commentStart + commentLength), comment);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), flags);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt32LE(local + 18), PAYLOAD_BYTES);
    assert.equal(bytes.readUInt32LE(local + 22), PAYLOAD_BYTES);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + localNameLength), nameBytes);
    local += 30 + localNameLength + localExtraLength + PAYLOAD_BYTES;
    central = commentStart + commentLength;
  }
  assert.equal(names.length, ENTRY_COUNT);
  assert.equal(local, centralStart);
  assert.equal(central, end);
}

async function verifyLoaded(archive, names) {
  assert.deepEqual(Object.keys(archive.files), names);
  for (const name of names) assert.equal(archive.files[name].dir, false);
  for (const index of [0, ENTRY_COUNT / 2, ENTRY_COUNT - 1]) {
    assert.deepEqual(await archive.files[names[index]].async("nodebuffer"), payload(index));
  }
}

export async function registerZipNameAdmission({ api, register }) {
  for (const depth of [1, 8]) {
    for (const encoding of ["flagged-ascii", "unflagged-ascii", "unicode"]) {
      const unicode = encoding === "unicode";
      const parents = Array.from({ length: depth - 1 }, (_, index) =>
        `${unicode ? "répertoire" : "directory"}-${index}/`).join("");
      const names = Array.from({ length: ENTRY_COUNT }, (_, index) =>
        `${parents}${unicode ? "entrée" : "entry"}-${String(index).padStart(4, "0")}.txt`);
      const zip = new JSZip();
      for (const [index, name] of names.entries()) {
        zip.file(name, payload(index), {
          createFolders: false,
          date: new Date("2020-01-01T00:00:00Z"),
          // A Unicode comment makes JSZip set bit 11 even for an ASCII filename.
          comment: encoding === "flagged-ascii" ? "café" : "",
        });
      }
      const ordinary = await zip.generateAsync({ type: "nodebuffer", compression: "STORE", streamFiles: false });
      for (const backing of ["buffer", "shared"]) {
        const bytes = backing === "buffer" ? ordinary : Buffer.from(new SharedArrayBuffer(ordinary.length));
        if (backing === "shared") ordinary.copy(bytes);
        assert.equal(bytes.buffer instanceof SharedArrayBuffer, backing === "shared");
        verifyFixture(bytes, names, encoding);
        register(`loadZipArchiveWithPreflight/name-admission/${encoding}/${backing}/depth=${depth}`,
          () => api.loadZipArchiveWithPreflight(bytes), {
            divisor: 100,
            after: archive => verifyLoaded(archive, names),
            workloadSemantics: "equivalent-output",
            workloadDetails: {
              publicOperation: "loadZipArchiveWithPreflight",
              outcome: "success",
              entryCount: ENTRY_COUNT,
              pathDepth: depth,
              nameEncoding: encoding,
              backing,
              compression: "STORE",
              payloadBytesPerEntry: PAYLOAD_BYTES,
              timedBoundary: "public-call-only",
              verification: "exact-entry-set+all-file-kinds+first-middle-last-payloads",
            },
            fixturePlacement: {
              archiveCreation: "registration-outside-invocations",
              recordVerification: "registration-local-and-central-names-flags-and-counts",
              afterEach: "verify-decoder-output",
              sharedMemory: "stable-reused-bytes-no-concurrent-mutation",
            },
          });
      }
    }
  }
}
