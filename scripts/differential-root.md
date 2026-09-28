# Public API differential harness

Build with `pnpm build` and stage the host binding with `pnpm native:build`.
Use Node 22+ and Bun 1.4.2 on PATH:

```sh
node scripts/differential-root.mjs --ci
node scripts/differential-root.mjs --seed 9 --seeds 16 --length 32 --shrink
node scripts/differential-root.mjs --replay artifacts-differential/example/divergence-1-replay.json
```

Each sequence runs in a fresh fixture and separate process for every selected
runtime, native mode (`require`, `auto`, `off`), and sync/async variant.
Linux adds `require` with `FS_SAFE_TEST_NO_OPENAT2=1`. The supervisor sets that
flag per lane, overriding an inherited value. Addon loads are observed; an
unexpected fallback, missing runtime, worker crash, or timeout fails the run.
The supervisor owns fixture cleanup, including after a killed worker.

The seed generates Root reads, opens, inspection, walking, writing, creation,
append, copying, removal, overwrite moves, and JSON writes. Atomic replacement,
standalone walking, and hashing select corresponding sync/async APIs.
Inputs include missing paths, directories at file positions, contained/dangling
links, hardlinks, zero and unlimited byte budgets, depth/entry limits, modes,
encodings, empty content and Unicode payloads. These finite sequences do not
model concurrent attackers, callbacks, archives, private ACL APIs, or mandatory
clone/no-clobber move capabilities.

Receipts retain normalized return values, error names/codes/categories, and
per-call/final trees: file bytes, entry kinds, link counts, portable mode bits,
and symlink targets. Descriptor identities and timestamps are excluded.
Directory and link sizes are excluded from portable result comparison. Windows
mode bits are omitted; unreadable file bytes are represented by their read error.
Returned text is preserved literally; only pathname fields are normalized.

The CI profile uses one seed and 24 calls per lane, explicit
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
