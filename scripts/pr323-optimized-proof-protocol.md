# PR #323 optimized candidate prospective protocol

Frozen before new sampling. No local timing is authorized by this protocol.
Do not dispatch until the coordinator confirms that the candidate is on origin.

## Revisions and separate questions

| Experiment | Baseline A | Candidate B | Question |
| --- | --- | --- | --- |
| producer-fix | `4b9b537aa06914e0b0d90e99db47420e432129eb` | `abc61e8bb7feda23cc5b2ed7b02174130a117cb5` | What is the optimization effect? |
| producer-final | `4b1afa00d6aee35753b5c25cc8555e3329657d34` | `eb6e155153c45b3ba41c1d45e60dd3697aa663dd` | Does the final producer family exclude material regression? |
| archive-final | `4b1afa00d6aee35753b5c25cc8555e3329657d34` | `eb6e155153c45b3ba41c1d45e60dd3697aa663dd` | Does the final archive family exclude material regression? |

The frozen trees are `153e82ac74396454bab2b3c2028987887be0af10`
(pre-optimization), `270d78d740868aeb9f65cbb632b906a11d07f9cd`
(optimization candidate), `c68cbea94eb3f6b480e41205390c8423cc9b7473`
(final baseline), and `bad73e65da8cbb1edde081aff6ea2cef5c47cead`
(final merged candidate). Every checkout must match both its commit and tree.
The original causal optimization pair is retained; only the final comparisons
include the subsequent main integration.

All experiments use Windows x64, Node 22.23.2, pnpm 11.25.0, and native mode
off. Each job builds its two exact clean revisions before timing, using equal
length checkout names and separate equal length Cargo target paths. A child
loads exactly one revision. Import/build/setup/output verification are outside
timing; the entire public call is timed. No local sample is performance evidence.

## Fixed sample and fresh randomness

Each experiment has 192 blocks and eight fresh processes per block: a balanced
ABBA/BAAB quartet and an independent A0/A1 quartet on that experiment's own A
revision. No process, fixture workspace, raw observation, bootstrap draw, or A/A
observation is shared between experiments. Each child performs 16 warmup and 16
timed calls for every workload, with the frozen cyclic Latin workload rotation.

Both producer experiments retain all eight existing workload cells:
`writeSiblingTempFile` / `writeExternalFileWithinRoot`, direct / private
producer, 64 B / 1 MiB payload. Each has 16 chronological cohorts of 12 blocks,
1,536 processes, 196,608 timed calls and the same number of warmup calls.
For each workload there are 6,144 timed calls in each A/B/A0/A1 arm; statistical
units are the 192 paired blocks, not individual calls.

The archive experiment retains all four existing cells: read gzip with 512
members, inspect gzip with 512 members, read TAR 1 MiB, and read gzip 1 MiB.
It has four chronological cohorts of 48 blocks, 1,536 processes, 98,304 timed
calls and the same number of warmup calls. Each workload again has 6,144 timed
calls in each arm and 192 scheduled blocks as the analysis units.

| Experiment | Schedule seed | Bootstrap seed |
| --- | ---: | ---: |
| producer-fix | 1049630630 | 2913561417 |
| producer-final | 3531893591 | 1745143147 |
| archive-final | 409032349 | 3805737781 |

These six seeds were generated before any new timing and are fixed. The sample
sizes preserve the already reviewed complete-family protocols. No formal power
guarantee or variance independence is asserted; uncertainty can still yield
HOLD. Retaining the identical workload families avoids outcome-based cell
selection and changing the established timing schedule.

## Unchanged analysis and decision rule

Use arithmetic child means, then equal weight the two processes in each arm of
each block. Estimate median paired block log ratios and absolute differences.
Use exactly 20,000 cohort-stratified circular moving-block bootstrap draws,
block length four, with the same indices for A/B and A/A within each experiment.
Report marginal two-sided 95% intervals per workload; do not claim simultaneous
family coverage. The unchanged material regression is above BOTH 5 percent AND
5 microseconds. Never subtract A/A bias from the A/B effect.

A/A must have both relative and absolute intervals contain zero, and must
exclude material bias in both directions (relative interval inside [-5%, +5%]
or absolute interval inside [-5 us, +5 us]). A workload ACCEPT requires valid
A/A and relative A/B upper bound <=5% OR absolute upper bound <=5 us. It proves
REGRESSION only with valid A/A and BOTH lower bounds above their thresholds.
Everything else is HOLD/INCONCLUSIVE. All workload cells must ACCEPT for a
family to ACCEPT. Any valid material regression rejects final acceptance; any
missing, invalid, incomplete, or uncalibrated required result yields HOLD.

The producer-fix experiment reports the optimization effect independently. Its
prespecified primary effect is private sibling/64 B: a demonstrated speedup
requires both relative and absolute upper bounds below zero and valid A/A.
An absent demonstrated speedup does not substitute for or invalidate the
separate final-baseline test; report it explicitly. Its other cells remain
visible, and its non-regression gate remains unchanged.

Stop after exactly the fixed sample, or immediately on integrity/runtime/child
failure. Retain all observations and failures. No filtering, pooling, adaptive
extension, or result-driven rerun is permitted. Do not select among repeated
completed runs. An incomplete run is HOLD and cannot be silently replaced.
Any later authorized protocol must preserve this run and be labeled a new
experiment, not an extension. Do not inspect partial effect estimates to decide
whether sampling continues.

## Runtime closure and old evidence

The optimization changes only `src/sibling-staged-file.ts` at runtime relative
to its parent; both private producer public APIs reach it. Relative to the old
hosted candidate, `src/sidecar-lock-acquire.ts` also changed. The broad advanced
and archive facade imports load these modules, so facade-import identity alone
does not establish unchanged timed execution.

Transfer may carry the original ACCEPT only after a fresh non-timing attestation
proves that the complete emitted JavaScript delta is confined to the
producer and sidecar modules plus the three #351 modules listed below, all
other compiled runtime and relevant compiler/dependency inputs are unchanged,
the transfer operation dependency closure is identical, and none of the changed
functions is invoked by the four complete transfer workload shapes.
The attestation must retain source/build/output manifests and instrumented
structural receipts; instrumentation must not run during performance sampling.
Any attestation failure yields HOLD; it does not silently add another timed
family or change this protocol. A future transfer run needs a separate frozen
protocol. Carry is limited to the old measured runtime/build configuration.

The prior archive result is INCONCLUSIVE; identical code cannot promote it to
ACCEPT. Therefore this protocol requires the full fresh archive family. Old
archive or producer observations are not pooled into any new analysis.

Preserve run [34809610915](https://github.com/openclaw/fs-safe/actions/runs/34809610915)
and its exact original revision labels and classifications:

- producer REGRESSION, report SHA-256 `4d9f9093fd5e2be931d581f429cbd37863a2ef5cc80609535e3188140d060538`;
- archive INCONCLUSIVE, report SHA-256 `35bcea788eb377f5dffe7a572956f1b97a298c9f3e131d174090ad3f51926c07`;
- transfer ACCEPT, report SHA-256 `4cea267ad51e241f8e08418071a6b81a52c905c5ae95cab91f4e9ea809e756af`.

## Integrity and independent verification

Freeze machine-readable plans, harness bytes and workflow in Git before
dispatch. Validate plan semantic hashes and exact revision/tree identities.
Record runner image, Node executable digest, build commands and exit codes,
full source/compiler inputs, emitted JS/WASM, dependency lockfile, fixture
hashes, child launch order, receipts, raw samples and telemetry. Recheck inputs,
harness, plan, fixtures and builds after sampling. Native loader and `.node`
load tripwires must remain untouched. Reject dirty or ambiguous build inputs.

Producer result identity, callback counts, receiver behavior, staging location,
payload hash, disappearance of producer path, and final cleanup are verified
outside timing. Historical private callback semantics are keyed to the exact
final baseline revision `4b1afa00d6aee35753b5c25cc8555e3329657d34`, not the A
label; the 4b9 baseline already has current receiver semantics. Main #350/#351
did not change the historical baseline's producer receiver behavior.

Independently reconstruct every schedule and raw sample from child receipts,
verify exact workload/call/launch totals and no omissions or duplicates, and
recompute block estimates, bootstrap intervals and classifications. Check
cohort/position balance and chronology; report instability without filtering.
Artifact availability and successful Actions completion do not alone imply
ACCEPT. Provide separate fix-effect, producer-final, archive-final, transfer
carry, and overall ACCEPT/HOLD/REJECT conclusions.

## Main integration and preserved cancellation

The earlier protocol at proof commit `3d5dfc4a4f36576249b1eaf41579d5485f67f008`
was dispatched as run
[34814119938](https://github.com/openclaw/fs-safe/actions/runs/34814119938).
The coordinator reported new main immediately after dispatch. That run was
cancelled during preliminary dependency installation, before repository checks
or any Windows timing job. It has no performance artifact or observations and
is preserved as cancelled evidence. This replacement uses new independent seeds.

Main #351 changes `bounded-read.ts`, `replace-file-copy-fallback.ts`, and
`replace-file-copy-source.ts`. Fresh exact builds before dispatch compare
210dde2 -> 4b1afa0 and abc61 -> eb6e155. Both deltas emit only those three runtime
JS files, and the new module bytes match between arms. Every non-changelog file
in the merge delta exactly matches main; the changelog delta is the same two
additive lines as main. Its only conflict was the changelog union.

The pre-dispatch attestation executes all 16 public workload shapes once on
each of these four fresh builds with in-memory function probes and no benchmark
clocks. Copy-fallback modules are not loaded, sync bounded reads and sidecar
acquisition are not called, and transfer/archive do not call producer functions.
The nine-file compiled transfer operation closure matches original hosted bytes
on both final arms. Targeted merged-candidate checks pass 50 tests with 10 skips
across copy-fallback batching, producer isolation and callback receiver files.

This establishes no observed runtime interaction for these workload shapes,
not equivalence of unrelated atomic fallback workloads. Local builds use Node
26.8.2 for source/compiled structural checks; all performance samples still
require hosted Node 22.23.2. Local WASM differs from the old hosted binary and
is never represented as measured. Its complete build inputs and local output
are unchanged across the merge. The attestation summary SHA-256 is
`80ceb1ef03972441e0bfba5607174586a7496d236f23c7e6a4e6b5b303a8336f`.
