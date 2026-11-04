// Test a supplied built or published WASM parser. Never builds or extracts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeFixture } from "./fixture-hex.mjs";

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error("usage: node archive-core/tests/wasm-interoperability.mjs <parser.wasm> [--system-reference]");
const systemReference = process.argv.includes("--system-reference");
const chunks = [1, 7, 511, 512, 513, 4096, 65536];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wasm = readFileSync(wasmPath);
const module = new WebAssembly.Module(wasm);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const root = new URL("./fixtures/interop/", import.meta.url);
const expectedMembers = JSON.parse(readFileSync(new URL("members.json", root), "utf8"));
const rows = readFileSync(new URL("cases.tsv", root), "utf8").trimEnd().split("\n").slice(1);
let comparisons = 0;
const observations = [];
for (const row of rows) {
  const [id, sha256, length, posix, windows, reference, ...limitText] = row.split("\t");
  const bytes = decodeFixture(readFileSync(new URL(`${id}.tar.hex`, root), "utf8"));
  assert.equal(digest(bytes), sha256, `${id}: fixture digest`);
  assert.equal(bytes.length, Number(length));
  const limits = limitText.map(Number);
  const modes = [];
  for (const windowsPaths of [0, 1]) {
    let first;
    for (const chunk of chunks) {
      const abi = new WebAssembly.Instance(module).exports;
      assert.equal(abi.init(...limits, windowsPaths), 0);
      // Zero-length offers are invalid at this ABI, unlike the Rust push API.
      assert.equal(abi.push(0, 0), -1);
      const text = () => Buffer.from(abi.memory.buffer, abi.text_ptr(), abi.text_len()).toString("utf8");
      const members = [];
      let error;
      let offset = 0;
      while (offset < bytes.length && !error) {
        const offered = Math.min(chunk, bytes.length - offset);
        new Uint8Array(abi.memory.buffer, abi.input_ptr(), offered).set(bytes.subarray(offset, offset + offered));
        for (let used = 0; used < offered;) {
          const consumed = abi.push(used, offered - used);
          if (consumed < 0) { error = text(); break; }
          assert.ok(consumed > 0 && consumed <= offered - used, `${id}: progress`);
          used += consumed;
          if (abi.member_type() >= 0) members.push({
            path: text(), type: abi.member_type(), size: abi.member_size(),
            mode: abi.member_mode(), offset: abi.member_offset(),
          });
        }
        offset += offered;
      }
      if (!error && abi.finish() !== 0) error = text();
      const observed = { result: error ?? "ok", members };
      assert.equal(observed.result, windowsPaths ? windows : posix, `${id}: windows=${windowsPaths}, chunk=${chunk}`);
      if (first) assert.deepEqual(observed, first, `${id}: chunk invariance`);
      else first = observed;
      for (const member of members) {
        assert.ok(member.offset >= 512, `${id}: member offset`);
        // A header event may precede a truncated body; only successful finish
        // establishes that every advertised payload range exists.
        if (!error) assert.ok(member.offset + member.size <= bytes.length, `${id}: complete range`);
        assert.equal(member.mode, 0o644);
      }
      if (!error) {
        assert.ok(Object.hasOwn(expectedMembers, id), `${id}: missing manifest oracle`);
        const actual = members.map((member) => ({ ...member,
          payloadSha256: digest(bytes.subarray(member.offset, member.offset + member.size)),
        }));
        assert.deepEqual(actual, expectedMembers[id], `${id}: member/payload contract`);
      }
      comparisons++;
      abi.dispose();
    }
    modes.push({ windowsPaths: Boolean(windowsPaths), ...first });
  }
  let system;
  if (systemReference) {
    const observed = spawnSync("/usr/bin/tar", ["-tf", "-"], {
      input: bytes, timeout: 5000, maxBuffer: 65536, encoding: "utf8",
    });
    if (observed.error) throw observed.error;
    assert.equal(observed.signal, null, `${id}: reference termination`);
    // The Rust tar reader's expected contract is asserted by the Rust test.
    // System libarchive is a separate observation, not an OCM oracle.
    system = { exitCode: observed.status, listed: observed.stdout, diagnostic: observed.stderr };
  }
  observations.push({ id, sha256, bytes: bytes.length, rustReferenceExpected: reference, modes, ...(system && { system }) });
}
const output = {
  schema: "fs-safe.archive-interop.v1", runtime: process.version,
  wasmSha256: digest(wasm), cases: observations.length, comparisons, chunks,
  systemVersion: systemReference ? execFileSync("/usr/bin/tar", ["--version"], { encoding: "utf8" }).trim() : null,
  observations,
};
console.log(JSON.stringify(output, null, 2));
