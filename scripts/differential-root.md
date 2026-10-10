# Public API differential harness

Build with `pnpm build` and stage the host binding with `pnpm native:build`.
Use Node 22+ and Bun 1.4.2 on PATH:

```sh
node scripts/differential-root.mjs --ci
node scripts/differential-root.mjs --seed 9 --seeds 16 --length 32 --shrink
node scripts/differential-root.mjs --replay artifacts-differential/example/divergence-1-replay.json
node scripts/differential-root.mjs --portable --corpus --runtimes node --no-fallback --out artifacts-differential-portable
node scripts/differential-root.mjs --fuzz-ms 60000 --runtimes node --length 32 --stop-first
node test/differential/compare.mjs linux-receipts macos-receipts windows-receipts
```

Each sequence runs in a fresh fixture and separate process for every selected
runtime, native mode (`require`, `auto`, `off`), and sync/async variant.
Linux adds `require` with `FS_SAFE_TEST_NO_OPENAT2=1`. The supervisor sets that
flag per lane, overriding an inherited value. Addon loads are observed; an
unexpected fallback, missing runtime, worker crash, or timeout fails the run.
The supervisor owns fixture cleanup, including after a killed worker.

The seed generates Root reads, opens, inspection, walking, writing, creation,
append, copying, removal, overwrite moves, and JSON writes. It also exercises
guarded synchronous copies, reused copy batches, file lock acquisition/release,
and temp workspace write/read/cleanup. Atomic replacement,
standalone walking, hashing, locks and temp workspaces select corresponding sync/async APIs.
Inputs include missing paths, directories at file positions, contained/dangling
links, hardlinks, zero and unlimited byte budgets, depth/entry limits, modes,
encodings, read-only files, dot names, NFC/NFD names, long names, empty content
and Unicode payloads. These finite sequences do not
model concurrent attackers, archives, private ACL APIs, or mandatory
clone/no-clobber move capabilities.

`test/differential/adversarial.test.ts` separately replays parent-to-outside
symlink substitutions at the existing pre-publication parent admission hook in
all three native modes. It requires a typed refusal, untouched outside sentinel,
and no staged output in either the outside tree or the displaced parent. These
deterministic schedules exercise the sampled admission boundary; they do not
claim atomic confinement against continuously racing peers in fallback mode.

Receipts retain normalized return values, error names/codes/categories, and
per-call/final trees: file bytes and SHA-256 hashes, entry kinds, link counts, portable mode bits,
and symlink targets. Descriptor identities and timestamps are excluded.
Directory and link sizes are excluded from portable result comparison. POSIX
permission and special bits (`0o7777`) are retained; Windows mode bits are omitted.
Unreadable file bytes are represented by their read error.
Returned text is preserved literally; only pathname fields are normalized.

The legacy CI profile retains its existing seed sequence and 24 calls per lane; the
portable corpus has a separate CI step. The legacy profile uses explicit
`mutationSymlinks: "reject"`, fresh exclusive-create destinations, and standalone
walks without an entry budget or followed aliases. It deliberately avoids
Windows omitted-policy link differences and the separately tested directory
collision contract. It runs in the native lanes, including Windows 2022,
and retains JSON receipts as workflow artifacts. Increasing the seed count is
an explicit cost choice; the broad profile defaults to 16 seeds and 32 calls.

The broad profile retains omitted link policies and bounded standalone walks.
It can report documented differences: the standalone walker uses filesystem
order (including different budget subsets or first-visited aliases), and Windows
native/legacy writers differ on omitted-policy links. Full returned standalone
lists are sorted for comparison; different subsets remain visible. A reported
divergence is a diagnostic to classify against the docs, not an automatic bug
verdict or an expected-pass allowlist.
Omitted mutation policy also preserves historical POSIX parent-alias behavior:
native beneath creation can refuse an absolute parent link, and the legacy
overwrite-move guard can refuse an alias accepted by the retained native move.
Explicit `follow-parents-within-root` canonicalizes those parents first; explicit
`reject` refuses them consistently. These differences remain visible in broad
receipts and are recorded, with their mechanism, in the corpus allowlist.

The checked-in corpus in `test/differential/corpus.mjs` contains four stable seeds.
`--portable --corpus` runs short successful operation sequences plus an expected
create collision. It avoids native-only capabilities, permission-sensitive
mutations and normalization-alias collisions. The comparator accepts only
completed, passing portable receipts with identical scripts and seed lists.
It compares every pair of platforms, including their recorded lanes. POSIX mode
bits remain strict between Linux/macOS and are omitted only when comparing with
Windows. Pathname spelling uses NFC for cross-OS comparisons; JSON/text payloads
remain literal. Symlink mode bits differ between Linux/macOS and are omitted in
the portable projection; link targets and file/directory modes remain strict.
Copy methods remain in receipts but do not affect equality:
clone, offload and byte copying must produce the same hashes, byte counts and
verified identities. The allowlist records these representation differences
and explains which documented capabilities are outside the portable subset.

`pnpm test test/differential/corpus.test.ts` runs the checked portable corpus
with sync/async variants, using all three modes when the native binding is
present and both fallback variants otherwise. `FS_SAFE_NATIVE_MODE=require`
makes a missing binding an error instead of a skipped native comparison.
Fuzzing is off by default and cannot combine with `--ci`, `--corpus` or replay.
`--fuzz-ms` bounds admission of new sequences; an in-flight sequence finishes
under the existing per-worker timeout. The existing 1,000-seed maximum still
applies. Every completed sequence retains its replay receipt.

`--shrink` deletes sequence chunks and options while retaining the operation and
success/error classification of the original divergence. A final deletion pass
seeks a one-operation-deletion fixed point. Shrinking is bounded by
`--shrink-budget` (200 attempts by default); exhausted reductions are marked.
This is not a proof of globally minimal input.

Every seed file retains all lanes' raw normalized receipts. The summary identifies
the first difference for each pair against the first lane; later differences
can be inspected in those receipts. Initial-tree differences are reported
separately so different fixture setup cannot masquerade as API equivalence.

Exit codes: **0** agreement, **1** observed divergence, **2** invalid input or
worker/infrastructure failure. Output directories must be empty. Replay inputs
are JSON operation specs produced by the harness; pathname validation confines
standalone helpers to portable fixture-relative names and forbids filesystem
adapter or destination overrides.

The JSON codec represents positive Infinity as `"$Infinity"` and escapes a
literal leading dollar sign by doubling it. Use the exported `encode`/`decode`
helpers when constructing or inspecting replay files so literal text, including
`"$Infinity"` itself, remains text.

The final summary distinguishes `passed`, `diverged` and `incomplete`.
An infrastructure failure never becomes a clean result just because no complete
pair was available to compare.
