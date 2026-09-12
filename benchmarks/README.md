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
work and cleanup performed *by the method* remain inside it. Open and acquire
cases exclude later close/release, which have their own rows. Representative
payload assertions run outside measurement. Reads cover 128 B, 64 KiB, 1 MiB,
2 MiB, the default Root budget of 16 MiB, and an explicit 32 MiB budget;
writes compare both durability settings without changing package defaults.

For a quick executable coverage check:

```sh
pnpm benchmark:methods --mode off --iterations 1 --samples 1 --warmup 0
```

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
