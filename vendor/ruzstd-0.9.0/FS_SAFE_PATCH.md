# Local decoded-block and Huffman stream corrections

This directory contains the `ruzstd` 0.9.0 registry library source, with bounded corrections in `src/decoding/block_decoder.rs`, `src/decoding/errors.rs`, and `src/decoding/literals_section_decoder.rs`.

- Upstream: https://github.com/KillingSpark/zstd-rs
- Source commit: `f833802b674e6b9360a259d25c20940e25a54e79`
- Registry archive: https://crates.io/api/v1/crates/ruzstd/0.9.0/download
- Archive SHA-256: `a252f5e20f038fe7b4ea53e073e65398d652c864cc162fc77c56c2f13717b888`
- License: MIT; the original copyright and license are retained in `LICENSE` and reproduced in the package's `THIRD_PARTY_NOTICES.md`.
- `UPSTREAM_SHA256SUMS` records every original registry file before the correction. Two incidental trailing spaces are removed from upstream `Readme.md` for repository whitespace checks; no other retained upstream file is modified. Local regression tests live in fs-safe's `archive-wasm` crate and archive tests, rather than this snapshot.

Upstream 0.9.0 checks a compressed block's encoded length but does not enforce its decoded limit, `min(frame window size, 128 KiB)`. A small-window block can therefore expand beyond that bound. Reading the public output stream cannot repair this reliably because the decoder retains an unobservable history window.

The correction checks raw/RLE lengths and compressed input lengths, bounds regenerated literals before allocation, bounds the sequence count before its vector allocation, and charges all literals plus sequence match lengths before extending output history. It applies to every block without changing frame headers, entropy state, or the public API. Valid multi-block streams can still produce more total output than their history window.

Upstream also checks only the combined regenerated count of four Huffman literal streams. RFC 8878 §3.1.1.3.1.6 requires each of the first three streams to decode exactly `ceil(Regenerated_Size / 4)` bytes, with the fourth supplying the remainder. The correction rejects impossible remainder arithmetic before allocation and limits each stream's output before appending excess symbols. Exact output counts and bitstream termination are checked independently for every stream. The same bound and termination check cover single-stream literals, including an incomplete final Huffman symbol that upstream could otherwise accept by reading implicit zero bits past the stream end. Compressed and treeless tables share these checks; valid fourth-stream remainders are preserved.

The snapshot is excluded from the root Cargo workspace; its benchmark and development dependency tree is not part of fs-safe's checks. `archive-wasm` uses it as a path dependency, and npm consumers receive only the bundled portable WASM decoder and notices.

Remove this snapshot and restore a registry dependency when a published upstream release enforces these bounds before expansion and passes fs-safe's malformed-block, Huffman stream-length and termination, valid multi-block, integrity, budget, and cancellation regressions.

Three upstream binary-only test fixtures (`test_fixtures/abc.txt.zst`, `test_fixtures/window_8mib.zst`, and `test_fixtures/window_128mib.zst`) are omitted from this production snapshot. Their original hashes remain in `UPSTREAM_SHA256SUMS`; they are not library build inputs. The fs-safe codec regressions use reviewable hexadecimal fixtures and cover small-window and maximum-window boundaries. Running the upstream crate's own fixture tests requires restoring those files from the verified registry archive.
