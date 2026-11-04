# Archive interoperability corpus

This corpus records the current strict admission contract. It does not change
policy, extract files, or qualify a new consumer or public crate API.

The concrete compatibility case comes from public
[OCM archive.rs](https://github.com/openclaw/ocm/blob/1b18a425fa183044142f3d483b0d7ba1ee67464f/src/infra/archive.rs#L613):
OCM uses Rust `tar` 0.4.46 to emit `LIBARCHIVE.symlinktype=dir` before a directory
symlink. Its restoration code also reads that metadata. The strict
[fs-safe PAX parser](https://github.com/openclaw/fs-safe/blob/f4071747c0a784001ceffea12983dbcdff9a3a1d/archive-core/src/tar_pax.rs#L100)
rejects that key. The actual `tar` writer also emits an empty PAX header name,
which the strict parser rejects before reading the attribute. The writer-pattern
test checks both independent incompatibilities, using a named-header control to
isolate the unsupported attribute. It reproduces the relevant `tar` calls
with synthetic values; it does not execute OCM's filesystem capture or restore.
Upstream OCM, fs-safe and tar-rs retain their authorship and licensing.

## Run

From the repository root, with the declared Rust toolchain available:

```sh
pnpm archive:interop:test
```

The Rust test compares the strict core to the existing test dependency `tar`
0.4.46. Accepted members must match path bytes, type, size, mode, payload offset
and payload bytes. Rejections must retain their exact error text and error kind.
Both `Read` and `push` are exercised with seven chunk sizes and both path modes.
The second test uses the same directory-link writer calls as OCM, verifies exact
golden producer bytes, and checks that the reference reader retains the PAX
attribute while the strict core rejects it without emitting a member. The
unmodified writer output fails with `entry path is empty`; naming its PAX header
and recomputing the checksum exposes the separate unsupported-key rejection.

To test a supplied built or published WASM asset without building or installing
that package:

```sh
pnpm archive:interop:wasm ./dist/archive-parser.wasm
pnpm archive:interop:wasm ./dist/archive-parser.wasm --system-reference
```

The optional system reference runs `/usr/bin/tar -tf -` on synthetic bytes with a
five-second deadline. It lists only. It never extracts. Its version, exit status,
names and diagnostics are observations separate from the Rust reference oracle.
Do not label a system-reader result as OCM execution or Rust-native/WASM parity.
An externally supplied asset must be identified by package version, integrity,
source association and WASM digest; source association alone is not reproducible
build or provenance-signature verification.

`fixtures/generate-interop.mjs` deterministically generates 20 small synthetic
archives and indexes those plus the actual Rust writer's golden output. It also
writes their SHA256 index and explicit WASM member/payload expectations. Archives
are stored as lowercase `.tar.hex` snapshots with 64 bytes per full line so their
contents remain reviewable. The index hashes and lengths describe decoded TAR
bytes; both runners validate the text encoding before parsing those bytes.
Regenerate with `pnpm archive:interop:fixtures`. No host metadata, real user files,
clock values, compression, or extraction are involved. The WASM runner checks
the indexed hashes and sizes, exact outcomes, explicit successful member records
and payload hashes, and chunk invariance. Seven chunks times two path modes
gives 294 terminal-outcome checks, including 119 successful manifest checks.

The synthetic writer example emits the golden fixture without extraction:

```bash
set -o pipefail
pnpm --silent run archive:interop:writer | node --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; import { encodeFixture } from "./archive-core/tests/fixture-hex.mjs"; writeFileSync("archive-core/tests/fixtures/interop/rust-tar-directory-link.tar.hex", encodeFixture(readFileSync(0)));'
pnpm archive:interop:fixtures
```

The source test compares the example's writer pattern against these exact bytes;
an upstream writer change requires an explicit fixture/contract review.

## Current contract

| Corpus group | Strict core contract | Reference comparison |
| --- | --- | --- |
| Ordinary file, empty archive | Admit; retain payload range or zero members | Same members |
| Plain symlink and hardlink | Emit link type with zero size | Same member identity; extraction policy remains separate |
| Directory-link PAX | Reject unsupported metadata, before member emission | General archive readers can retain the attribute |
| Actual Rust writer PAX header | Reject empty header name, before PAX parsing | Rust `tar` accepts its own writer output |
| Long local PAX and GNU paths | Admit; preserve effective path and payload range | Same effective member identity |
| NFC/NFD and case spelling | Preserve distinct input spellings | No normalization or collision-policy claim |
| Raw non-UTF8 name | Reject `archive-entry-path-invalid` | General readers may preserve opaque name bytes |
| Colon name | Admit in POSIX path mode; reject in Windows path mode | Path-mode validation is separate from reader framing |
| Missing/one-block EOF | Reject missing two-block EOF | General readers may stop after the last entry |
| Nonzero trailing bytes after EOF | Reject | General readers may stop at EOF without consuming the trailer |
| Truncated header/body | Reject with the corresponding framing reason | Reference reader must reject incomplete input |
| Entry/metadata/decoded/manifest budgets | Reject the selected exceeded limit | General reader has no equivalent configured policy |

## Integration boundaries

`TarMember` exposes path, type, size, mode and payload offset. It does not expose
the link target or `LIBARCHIVE.symlinktype` value. Allowlisting the attribute
alone would not supply directory-link intent through this interface. Consumer
owners must choose a metadata transport and restoration contract before an
adapter is designed. Keep the existing rejection until that decision is made.

A member event can precede body or EOF validation. A truncated-data case may emit
an advertised range that is unavailable in the final input. Consumers must drain
the whole stream and require successful `finish`; a header event is not final
archive approval. Caller-owned extraction, confinement, link policy, cancellation,
permission restoration and atomic publication remain outside this parser corpus.

Empty offers differ by layer: the Rust core accepts an empty `push`/`Read` without
finishing; the private WASM ABI rejects zero-length `push`. The tests preserve
these existing contracts rather than treating them as an unexplained mismatch.

This first corpus does not qualify actual Windows filesystem behavior, link or
permission restoration, sparse archives, all malformed metadata variants,
compression codecs, resource exhaustion, cancellation, or packed/native adapter
equivalence. Existing focused core tests cover additional malformed-header and
limit cases; run those and the normal repository checks before shipping. A source
test that has not executed is a proposed regression check, not measured parity.
