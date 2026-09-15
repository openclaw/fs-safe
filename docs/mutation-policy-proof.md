# Hosted mutation-policy proof

The `mutation policy public behavior proof` workflow builds the exact event-head
package and host addon on Node 24 Linux, macOS, and Windows. Each case executes in
a fresh process, uses a private temporary fixture, and emits only a bounded,
canonical receipt. POSIX workers require both real and effective non-root UIDs.

Receipt schema `fs-safe-mutation-policy-proof-v2` deliberately does not describe
final directory emptiness as a mutation-dispatch count. Root replacement records
the unchanged contents of the original and replacement parent; denied redirect
records rejection and unchanged denied/displaced parents. The existing JS mkdir
counters name their exact child or next component. None counts native syscalls
or excludes transient mutations that leave no final trace.

## Additional hosted cases

Each POSIX write/create/copy worker, under both native-off and native-require,
performs an eligible success control, an exact deeper-parent denial after an
earlier parent is created, a denied redirect after preflight, and a stale-parent
replacement at the public pre-mkdir authority boundary. Exact directory listings
and sentinels verify that denied/current/displaced parents contain no prohibited
child, target, or stage. Copy sources must retain their original bytes.

Redirect injection uses the existing public `@openclaw/fs-safe/test-hooks` subpath
from `dist`, not a mocked native binding. Only these isolated workers enable
`NODE_ENV=test`. The exact target and single hook visit are required. The hook is
after policy preflight but before parent admission; it must not be described as
a post-parent-admission hook. Stale replacement instead uses the public authority
callback after child-create policy admission, with an existing sentinel parent
and a still-missing child. Both implementation files that enforce the following
freshness check are hash-bound. No unchecked callback ordinal chooses a fault.

Representative POSIX `Root.write` workers refuse authority before the first mkdir,
after one parent has been created and before the next mkdir, before staging, and
immediately before publication. Epoch selection uses actual fixture state. The
publication refusal requires a real single-link, caller-owned mode-0600 stage
containing the complete payload while the destination still contains its original
sentinel. The same rejection object must escape, no callback may follow refusal,
and the owned stage must be gone before fixture teardown.

Windows workers exercise buffer `Root.write` through a stable final-file symlink,
then refuse before staging a newly created placeholder, before publishing over a
new placeholder, and before publishing to an existing symlink-selected destination.
They verify alias binding, destination preservation, observed placeholder/stage
states, and cleanup before fixture teardown. The default native-off and explicit
`verify-content-with-lock` native-require configurations both select the existing
Windows JS buffer writer. The compatibility route is expected not to load the
addon; the receipt does not mislabel this as native publication or evidence that
content-verification fallback or lock contention was exercised.

## Bounds and interpretation

The receipt remains below 32 KiB, each worker has a 15-second process timeout and
4-KiB stdout limit, and the proof step has a six-minute outer timeout. Worker I/O
and cleanup retain their existing deadlines. The canonical pending/failed receipt
is preserved if setup, a worker, provenance validation, or emission fails.
Source, built modules, the public test seam, harness helper, contract tests, and
host addon are hashed and checked again after workers.

These are deterministic representative observations, not an exhaustive race proof
or syscall audit. Existing hash-bound internal tests remain complementary for
other awaited-admission, receipt-refresh, and observation-failure interleavings.
Windows root replacement and POSIX-specific pinned routes are not claimed on
Windows. Hosted CI and exact artifact inspection are required before relying on
new receipts; the proof supplies no performance release clearance.
