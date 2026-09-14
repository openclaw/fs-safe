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
The broader cases add lexical paths at depths 0/8/32, batches of 100/1,000
paths, 1,000-entry listings and walks, private/public stores through 1 MiB with
both durability settings, 1,000-item JSON documents and concurrent updates,
contended/distinct lock groups, and loading 100 claimed queue entries. Queue
fixtures are acknowledged outside timing; lock-group timings include release.
Scaling cases add 1/8/32 concurrent Root and FileStore reads, batches of 100
lock-manager constructions with 0/32/128 retained locks, and scans of 100/1,000 unexpired
store entries. Forced permission-error replacement cases exercise the public
filesystem adapter with 128 B, 1 MiB, and 16 MiB payloads, both restoration
policies, and both sync/async methods. Temp-file and parent syncing are disabled
for these cases; `restore-original` still includes its required destination
sync. Fixture reset remains outside timing.
Name-collection cases cover ASCII, NFC, and decomposed paths at depths 1/8/32;
rejected paths and store keys; 2,048-member ZIPs with shallow/deep ASCII and
Unicode names; and long callback-output filenames. Expected synchronous
rejections use the checked per-call timing path, including during measurement.
Borrowed-handle transfers and Root byte-copy cases cover the same payload sizes;
the Root cases use `clone: "never"` and `durable: false` to expose transfer costs.
Directory iteration includes full and early-stop scans in filesystem and sorted
order. Tree-copy cases use explicit auto, never, and supported always policies
over 64 small files, one 1 MiB file, and nested and empty directories.
TAR/gzip member reads, extraction, and inspection cover 1 MiB and 16 MiB payloads; 512-member read and
inspection cases expose metadata-event transport costs.
ZIP reads and extraction also cover 1 MiB and 16 MiB stored and deflated members
to expose payload integrity costs beyond tiny archive fixtures. ZIP admission and
member reads also cover 512 ASCII and Unicode names with stored and deflated data.
Filtered ZIP extraction visits all 512 members while skipping their output,
isolating admission and planning from destination-file writes.
The native directory-open case times admission separately from descriptor close.

For a quick executable coverage check:

```sh
pnpm benchmark:methods --mode off --iterations 1 --samples 1 --warmup 0
```

Use `--filter rejected` to exercise the synchronous rejection workloads.

The `benchmarks` workflow also has an optional manual method audit. Set
`method_audit=true`, choose `platform=all|linux|macos|windows`, and optionally
provide `compare_ref`. It builds both revisions on the same runner and uses
the candidate harness for both, saving JSON reports for JavaScript and native
modes. `iterations` and `samples` control the measurement budget. These full
sweeps identify candidates; use interleaved focused measurements before claiming
a speedup, especially for storage-sensitive operations.

Use `--filter readFileDescriptorBounded` to repeat one family. Filtered reports
are marked explicitly and do not imply all cases ran. `--dist /absolute/dist`
lets the same harness measure a saved build; preserve the WASM asset alongside
JavaScript and keep the output directory named `dist` (for example,
`/snapshot/baseline/dist`) for the parser's package-relative asset lookup.
Reports identify the JavaScript/WASM build by a content hash and
record a separate SHA-256 for the actual loaded native addon. They also record
the harness checkout revision and a hash of the actual benchmark code, package
manifest, and lockfile (including uncommitted edits), Node version, platform, CPU, requested native
mode, and whether the binding loaded. The addon is resolved relative to that build, so
keep its matching platform package available too.

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
