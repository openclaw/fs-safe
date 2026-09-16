# Method performance audit

Run from a built checkout with the declared pnpm version:

```sh
pnpm build
pnpm benchmark:methods --mode off --json /tmp/fs-safe-off.json
pnpm native:build
pnpm benchmark:methods --mode require --json /tmp/fs-safe-native.json
```

The runner inventories callable exports from every package subpath and checks
methods on Root, stores, path scopes, locks, directory pins, staged files, and
temporary workspaces. An uncovered callable fails before measurement. Re-exports
share one case; constants and types are not calls. Test-only instrumentation and
the deprecated Python configuration alias have explicit exclusion reasons.
Native-only methods are recorded as skipped when unavailable. Windows ACL and
private-directory operations require a real Windows run; POSIX does not time
an unsupported-platform response as if it were useful work. Trash admission is
measured on a rejected synthetic path so this command never writes to a user's
real Trash. This is representative method coverage, not exhaustive branch or
platform coverage; security and concurrency tests remain separate.

Each row reports microseconds per call, all sample averages, their median, and
minimum/maximum. Defaults are 100 iterations, five samples, and five warmup calls.
Each `samplesUs` element is explicitly the average microseconds per call across
that row's recorded `iterations`; it is not an individual-call latency sample.
Cheap synchronous functions run batches of 100 calls per requested iteration.
Expensive archive, durable-store, and large-payload cases use fewer iterations, recorded per row.
Inputs are synthetic. Fixture setup and cleanup run outside the timer; callback
work and cleanup performed *by the method* remain inside it. The Windows
workspace receives a private ACL before fixture creation so its files inherit
private permissions; Unix mode bits alone do not restrict them. Open and acquire
cases exclude later close/release, which have their own rows. Representative
payload assertions run outside measurement. Reads cover 128 B, 64 KiB, 1 MiB,
2 MiB, the default Root budget of 16 MiB, and an explicit 32 MiB budget;
writes compare both durability settings without changing package defaults.
Hash cases verify the digest as well as the byte count outside measurement.
The `tempWorkspace` filter selects 17 rows across asynchronous and synchronous
creation: two ordinary rows, two requested-`0750` mode rows, one synchronous
forced-correction row, and 12 existing/missing-root rows at generated depths
4/8/32. Linux and macOS requested-mode preflights prove whether ordinary or
forced umask creation starts at `0750` or `0700`; the forced fixture restores
the process umask on setup, operation, verification, and cleanup failures.
Every row checks final mode and owner where portable, successful cleanup, and
path absence outside timing. Depth-row reports also record the actual canonical
root component count so runner-specific temporary path prefixes remain visible.
The broader cases add lexical paths at depths 0/8/32, batches of 100/1,000
paths, 1,000-entry listings and walks, private/public stores through 1 MiB with
both durability settings, 1,000-item JSON documents and concurrent updates,
contended/distinct lock groups, and loading 100 fresh or resumed queue claims.
`PathScope.resolveAll/count=100` and `count=1000` exercise repeated absolute-root
normalization across ordinary lexical path batches. Compare these with the
singleton `PathScope.resolveAll` row when evaluating batch optimizations; relative
roots still resolve against the working directory for each input, and Windows
root normalization remains platform-specific. Internal drive-component scan
timings describe validation cost rather than complete Root I/O latency.
Windows Root-path rows separately measure exact-prefix admission, whose repair
adds no filesystem observations, and alternate-casing identity admission.
Resumed fixtures are first claimed outside timing to expose retry durability costs.
Single and batch migration cases include callback execution and durable replacement,
then verify the returned entry and the published processing file outside timing.
Queue fixtures are acknowledged outside timing; lock-group timings include release.
Scaling cases add 1/8/32 concurrent Root and FileStore reads, batches of 100
lock-manager constructions with 0/32/128 retained locks, and scans of 100/1,000 unexpired
store entries. Six `Root.write/mutation-admission/` rows cover policy-bound
writes through existing and missing parents at depths 1/8/32. The focused
`shared-js-mutation-admission` family pairs adjacent `policy=none` and
`policy=enabled` controls for `Root.openWritable` update, append, and replace,
`Root.append`, and `Root.mkdir` at the same depths and parent layouts. It has
exactly 60 portable rows: 36 open-writable, 12 append, and 12 mkdir. Windows
adds 24 `Root.write` and 12 `Root.create` rows for 96 total. All use a divisor
of 10; fixture reset, result verification, descriptor close, and cleanup stay
outside timing. Forced permission-error replacement cases exercise the public
filesystem adapter with 128 B, 1 MiB, and 16 MiB payloads, both restoration
policies, and both sync/async methods. Temp-file and parent syncing are disabled
for these cases; `restore-original` still includes its required destination
sync. Fixture reset remains outside timing.
Name-collection cases cover ASCII, NFC, and decomposed paths at depths 1/8/32;
rejected paths and store keys; 2,048-member ZIPs with shallow/deep ASCII and
Unicode names; and long callback-output filenames. The 17 filename-sanitizer
rows include the ordinary and fallback calls plus a 15-row fallback boundary
matrix. Every row is checked eagerly before filtering or timing against a
recognized legacy or sanitized profile. Manual method-audit runs independently
derive the expected profile from the measured revision's tracked
`src/filename.ts` blob. Standalone runs select the profile through behavioral
checks and report `binding: "standalone"` with no independently bound expected
profile. Reports mark rows as `equivalent-output` or `changed-output`. The four
long-name endpoint rows retain equivalent output and
verify outside timing that the destination content is exact, the staging file
is gone, `.txt.part` survives truncation, and both NFC and NFD forms of the
staging component fit within 255 bytes. Expected synchronous
rejections use the checked per-call timing path, including during measurement.
Borrowed-handle transfers and Root byte-copy cases cover the same payload sizes;
the Root cases use `clone: "never"` and `durable: false` to expose transfer costs.
Directory iteration includes full and early-stop scans in filesystem and sorted
order. Tree-copy cases use explicit auto, never, and supported always policies
over 64 small files, one 1 MiB file, and nested and empty directories.
TAR/gzip member reads, extraction, and inspection cover 1 MiB and 16 MiB payloads; 512-member read and
inspection cases expose metadata-event transport costs.
A 10,000-member plain-TAR inspection case uses 128-byte payloads to expose
small-file read overhead. The archive is assembled in memory outside timing;
every returned path, kind, and size is verified after measurement.
Gzip member reads and inspection also cover a small member followed by 64 MiB
of valid zero container padding, separating suffix validation from payload decoding.
The `native-codec/` filter selects 16 zstd/bzip2 rows. Twelve cover normal
extraction and buffered member reads for one 128-byte member, 512 128-byte
members, and one 16 MiB member. Four more extract and read one 4 MiB member from
258 concatenated streams: a TAR header, one independently compressed 16 KiB
SHA-256-counter block replayed 256 times, and the TAR trailer. The repeated
block is deliberately resistant to compression within each stream while
keeping the checked-in components small. Component, assembled-compressed,
decoded-TAR, and payload hashes are checked while the archive is assembled
outside timing. All rows require native mode and record explicit skips when the
binding is unavailable. Setup, payload verification, and destination cleanup
are outside timing. The four added rows measure concatenated-stream refill
throughput, not single-frame high-entropy throughput or cancellation latency.
Deterministic Rust tests separately check cancellation between raw input reads.
ZIP reads and extraction also cover 1 MiB and 16 MiB stored and deflated members
to expose payload integrity costs beyond tiny archive fixtures. ZIP admission and
member reads also cover 512 ASCII and Unicode names with stored and deflated data.
Filtered ZIP extraction visits all 512 members while skipping their output,
isolating admission and planning from destination-file writes.
The native descriptor cases isolate host-fd admission and directory open/return;
the latter remains timed separately from descriptor close.

Windows secure-read rows distinguish the measured JavaScript contract from the
loaded addon's capabilities. A build containing `secure-file-windows.js` uses
`readSecureFile/descriptor-acl` when its descriptor capability is available, or
`readSecureFile/permission-unverified` for a verified expected rejection when
it is not. Older builds use `readSecureFile/legacy-pathname-acl` and verify a
successful read, including in native-off mode. All successful rows check the
returned bytes. Detection uses the selected `--dist` directory, so a saved
current build is not mistaken for a legacy baseline. These labels retain
`readSecureFile` callable coverage; rejection timing is not successful-read timing.

For a quick executable coverage check:

```sh
pnpm benchmark:methods --mode off --iterations 1 --samples 1 --warmup 0
```

Use `--filter rejected` to exercise the synchronous rejection workloads.

The `benchmarks` workflow also has an optional manual method audit. Set
`method_audit=true`, choose `platform=all|linux|macos|windows`, and optionally
provide `compare_ref`. A five-minute prepare job first validates every input,
resolves the candidate and baseline once to full commit and tree IDs, and pins
the reviewed harness checkout to `github.workflow_sha`. For an exact study,
set the 40-hex `candidate_ref` for C and independently set
`expected_harness_sha` to the reviewed workflow commit for H; C and H do not
need to be the same revision. A named `compare_ref` remains supported for
convenience, but branch/tag ambiguity and refspec, revspec, URL, option, and
control-character forms are rejected before the platform jobs fan out.

The platform jobs use three fixed sibling checkouts: harness (H), candidate
(C), and baseline (B). H has its own frozen dependency install and runs its
own `benchmarks/runner.mjs`; C and B are installed and built from their own
lockfiles and layouts, and H always receives an explicit absolute `--dist` for
the measured build. The jobs disable Git automatic CRLF conversion before any
checkout, retaining Git blob bytes while recording both source-blob and
physical installation hashes. `node_version` selects Node 22 or 24 and
`timeout_minutes` selects 45, 90, or 120 minutes. `iterations` is limited to
1–10,000, `samples` to 1–25, `blocks` to 1–5, and `filter` to 256 UTF-8 bytes
without controls. The defaults remain 20 iterations, five samples, sequential
baseline/candidate order, one block, both native modes, Node 24, a 45-minute
timeout, and the `rebuild` control.

`control=rebuild` installs and builds C and B separately. Comparing the same
commit this way is labelled `same-source-rebuild`; differing commits are
labelled `source-comparison`. `control=same-artifact` requires C and B to
resolve to the identical commit, installs/builds C once, and points every B
and C label at the exact same C dist and adjacent dependency/native layout.
The labels still run in separate Node processes. With a comparison ref and
nonempty filter, `order=abba` records baseline, candidate, candidate, baseline
within each block; `order=baab` records the reverse balanced sequence. Each
position and native mode has a separate source-labelled JSON report. These
full sweeps identify candidates; use repeated blocks of both orders before
claiming a speedup when order bias is material, especially for
storage-sensitive operations.

Use `--filter readFileDescriptorBounded` to repeat one family. Filtered reports
are marked explicitly and do not imply all cases ran. `--dist /absolute/dist`
lets the same harness measure a saved build; preserve the WASM asset alongside
JavaScript and keep the output directory named `dist` (for example,
`/snapshot/baseline/dist`) for the parser's package-relative asset lookup.
Reports identify the JavaScript/WASM build by a content hash and record a
separate SHA-256 for the actual loaded native addon. Manual workflow reports
also carry versioned `methodAuditEvidence`: H's workflow ref, commit, tree,
workflow-file and benchmark hashes; C/B's requested ref, resolved commit and
tree; the role, build ID, control, order, block, and position; and the actual
Node, platform, architecture, CPU, hosted-image, and runner environment.
Package manifests, lockfiles, complete dist trees, staged/installed native
addons, and a bounded dependency-layout identity are hashed before and after
the measurement sequence. A missing report, changed plan, changed covered
installation identity, unexpected dist hash, or loaded-addon mismatch fails
finalization.

Each manual report also binds its selected dist to the immutable plan by
following its report-plan `buildId` to the build's `sourceRole` and then to
that source's commit, tree, and tracked filename-source blob/hash. The expected filename
fallback profile comes from that source content, independently of the measured
behavioral probe; unknown source forms and expectation mismatches fail before
timing. A same-artifact baseline label therefore inherits the candidate build's
source expectation. The reviewed harness never reads or hashes an `H/dist`
directory while making this decision.

This evidence workflow is for trusted, reviewed H/C/B revisions. Candidate and
baseline build scripts and measured library code execute with the runner
account's authority in separate Node processes; the checkout separation and
identity receipts detect accidental drift but are not a security sandbox and
do not make hostile revision execution safe. Each runner-produced JSON file is
required to be absent before launch, then its SHA-256, device, inode, size, and
nanosecond modification time must remain unchanged through all later launches
and the post-measurement installation snapshot. Provenance annotation happens
only after that receipt is revalidated.

Dependency identity schema `pnpm-layout-manifests-locks-native-v1` hashes all
dependency paths, entry types and sizes, safe in-checkout link targets, package
manifests, pnpm layout/lock metadata, and native addons. It is deliberately not
a byte-for-byte hash of every dependency file; the frozen lockfile supplies
the remaining package-content identity. This limitation is recorded in every
report and must not be interpreted as a full installed-tree content hash. The
addon is resolved relative to the selected measured build, so keep its matching
platform package available too.

Compare builds on the same host, runtime, filesystem, and native mode. Alternate
baseline/candidate runs and inspect sample spread; fsync timings and shared-host
load can dwarf JavaScript changes. Warm-cache sequential latency does not measure
cold storage, concurrent throughput, or event-loop responsiveness. This report is
not a timing assertion in CI. CI smoke runs verify that the benchmark continues
to exercise real callable APIs.

For copy comparisons, specify identical worker counts: native tree cloning
defaults to 16 workers while portable Windows copying defaults to 4. Use the
same harness, payload, runtime, volume, and native mode for both builds:

```sh
pnpm benchmark:methods --mode require --filter copyTree/ --copy-shape nested --copy-files 64 --copy-file-bytes 4096 --copy-concurrency 1,4,8,16,32 --iterations 10 --samples 5 --warmup 1
```

`--copy-shape` accepts `empty`, `flat`, `nested` (one file per sibling directory),
or `mixed` (the default). Mixed adds a 1 MiB payload and splits the selected
files between the root and one nested directory. All shapes include an empty
directory. `--copy-files` defaults to 64, and `--copy-file-bytes` defaults to
4096. Generated file data is bounded to 512 MiB plus the mixed payload. Each
worker count runs auto, never, and supported always policies; explicit workers
are included in row names. Contents and directory listings are checked outside
timing. On Windows, `TEMP`/`TMP` select the fixture volume; on POSIX use `TMPDIR`.
