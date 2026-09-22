# Changelog

## Unreleased

### Fixes

- **Lock failure reporting:** preserve Root stale-removal authority rejections and nullish retry-option failures instead of replacing them with timeouts or `TypeError`s.
- **Secret-file errors:** report caught `null` or `undefined` failures as structured errors instead of masking them with an internal `TypeError`.

### Performance

- **Native errors:** reduce temporary allocations when constructing fixed filesystem error messages.

## 0.18.1 - 2026-09-22

### Fixes

- **Durable queue errors:** preserve the original read, validation, callback, or migration failure when closing the read descriptor also fails.
- **Secure temporary directories:** stop rejecting valid directories when Node reports negative device or inode IDs. Thanks @vincentkoc. ([#586](https://github.com/openclaw/fs-safe/pull/586))
- **Root write hardening:** prevent extra properties in wider options objects from enabling private writer controls or applying streamed-create byte limits to buffered writes. ([#571](https://github.com/openclaw/fs-safe/pull/571))
- **Error reporting:** preserve original errors from directory checks, secret reads, and Root opens when descriptor cleanup also fails. ([#574](https://github.com/openclaw/fs-safe/pull/574))
- **Lock timeouts:** keep async and sync retry deadlines stable when the system clock changes. Preserve wall-clock lock timestamps and stale-age checks.

## 0.18.0 - 2026-09-21

### Highlights

- **Security hardening for Root arguments:** explicit paths, payloads, and copy sources take precedence over matching properties in wider options objects. A supplied source Root retains its admission and read policy; directory creation and writable opens keep their internal controls. ([#577](https://github.com/openclaw/fs-safe/pull/577))
- **More reliable cancellation and failure reporting:** tree-copy workers receive cancellation even when caller abort handlers stop event propagation. Secret reads and asynchronous atomic operations preserve their selected failures when best-effort descriptor cleanup also fails. ([#561](https://github.com/openclaw/fs-safe/pull/561), [#566](https://github.com/openclaw/fs-safe/pull/566), [#545](https://github.com/openclaw/fs-safe/pull/545), [#554](https://github.com/openclaw/fs-safe/pull/554))
- **Reliable Windows publication and ownership checks:** keep missing buffered-write destinations absent until complete content is published, including across process interruption, and preserve write-only access when admitting a destination that appears during staging. Permission-query results must explicitly verify owner locality. ([#573](https://github.com/openclaw/fs-safe/pull/573), [#547](https://github.com/openclaw/fs-safe/pull/547))
- **Less repeated work in targeted workloads:** reduce metadata observations and Promise scheduling in secret reads, Root path resolution, and durable queues; reuse bounded, cleared scratch storage for fallback SHA-256. Measurements show gains in selected Linux read workloads, with workload-specific costs retained in the linked PRs. ([#535](https://github.com/openclaw/fs-safe/pull/535), [#536](https://github.com/openclaw/fs-safe/pull/536), [#549](https://github.com/openclaw/fs-safe/pull/549), [#550](https://github.com/openclaw/fs-safe/pull/550))
- **Smaller npm installs with intact TypeScript declarations:** stop shipping declaration maps that point to unpublished source files. Public declarations and exports remain available. Thanks @vincentkoc. ([#570](https://github.com/openclaw/fs-safe/pull/570))

### Compatibility and upgrade notes

- Explicit Root arguments remain authoritative even when JavaScript callers or structurally wider TypeScript options include `relativePath`, `data`, or `source`. Enumerable option getters still run and can throw; supported defaults and policy options keep their precedence. This fixes argument selection within the existing filesystem capability contract. ([#577](https://github.com/openclaw/fs-safe/pull/577), [Root contract](https://github.com/openclaw/fs-safe/blob/v0.18.0/docs/root.md))
- Injected Windows permission executors must return valid owner/current-user SIDs, an explicit boolean `remote`, and complete DACL facts. Missing or nonboolean locality leaves both inspectors unverified; `remote: true` retains the ACL report but does not grant trusted ownership. ([#547](https://github.com/openclaw/fs-safe/pull/547), [permission-query contract](https://github.com/openclaw/fs-safe/blob/v0.18.0/docs/permissions.md))
- Descriptor-close behavior remains operation-specific. Synchronous secret readers report a lone close failure before trimming or empty-content validation, while an earlier read or identity failure retains precedence. Atomic best-effort cleanup now treats synchronous adapter throws like rejected close promises; synchronous successful admission, parent-mode admission, and retained descriptor-owner closes keep their existing failure reporting. ([#566](https://github.com/openclaw/fs-safe/pull/566), [#545](https://github.com/openclaw/fs-safe/pull/545), [#554](https://github.com/openclaw/fs-safe/pull/554), [atomic cleanup contract](https://github.com/openclaw/fs-safe/blob/v0.18.0/docs/atomic.md))
- Root path properties are readonly metadata. Each Root retains its originally admitted canonical directory and identity; create another Root to select a different directory. Values in the supplied defaults object remain live for later operations. ([#546](https://github.com/openclaw/fs-safe/pull/546))

### Security hardening and correctness

- Preserve positional paths and payloads across Root reads, writable opens, writes, creates, appends, removals, and copies, including JSON and streamed wrappers. Keep Root-scoped copy sources authoritative instead of allowing an options property to substitute a raw path. `mkdir()` and `ensureRoot()` retain their distinct root-directory rules, and internal removal or writable-open fields cannot replace their caller-owned controls. ([#577](https://github.com/openclaw/fs-safe/pull/577))
- Keep missing destinations absent until buffered Windows `Root.write()` publishes complete content; existing destinations retain their previous bytes during staging. Re-admit raced destinations before replacement, preserving write-only access, link rejection, final authority checks, and cleanup. ([#573](https://github.com/openclaw/fs-safe/pull/573))
- Isolate tree-copy cancellation from caller event handlers across native cloning and portable byte-copy fallback. Preserve caller handlers, first-failure selection, and per-file cancellation; join admitted work before releasing descriptors and native signal handlers. Dispatched APFS/Btrfs bulk operations remain uninterruptible, and failed or cancelled copies can leave caller-owned output. ([#561](https://github.com/openclaw/fs-safe/pull/561), [copy cancellation contract](https://github.com/openclaw/fs-safe/blob/v0.18.0/docs/copy.md))
- Preserve synchronous secret-read and identity-validation errors, including their causes, when closing the descriptor also fails. Make one close attempt and retain the existing lone-close failure behavior. ([#566](https://github.com/openclaw/fs-safe/pull/566))
- Preserve asynchronous copy-source results and destination-admission failures when custom filesystem adapters throw synchronously during best-effort close. Apply the same handling to atomic admission pins, best-effort parent synchronization, and replacement pins that were not adopted, without changing filesystem identity checks or retained-owner close policy. ([#545](https://github.com/openclaw/fs-safe/pull/545), [#554](https://github.com/openclaw/fs-safe/pull/554))
- Reject unverified Windows owner locality while retaining valid local/remote classification, SID-validation precedence, bounded diagnostics, and exact rejected values. Share permission-report metadata across native and command inspection without sharing mutable public results or changing ACL policy. ([#547](https://github.com/openclaw/fs-safe/pull/547), [#567](https://github.com/openclaw/fs-safe/pull/567))

### Performance and package size

- Reduce redundant metadata observations and scheduling in secret reads, regular-file admission, and staged publication. An isolated Linux comparison measured `readSecretFileSync()` about 11% faster; five other measured calls were roughly unchanged. Exact identity and mutation checks remain. ([#535](https://github.com/openclaw/fs-safe/pull/535))
- Share Root metadata traversal and reuse normalized missing-path suffixes instead of rebuilding per-component arrays. An isolated Linux/native-off comparison measured roughly 3–4% lower resolver medians, with a slightly higher maximum synchronous sample average. Preserve async/sync canonicalization routes, Windows alias rejection, dangling-link behavior, and observation receipts. ([#536](https://github.com/openclaw/fs-safe/pull/536), [#562](https://github.com/openclaw/fs-safe/pull/562))
- Consolidate durable-queue directory and metadata ownership while retaining asynchronous file I/O, path admission, exact identities, and recovery synchronization. Small and 64 KiB reads measured 8.68% and 13.78% faster in a balanced Linux comparison; durable medians stayed within −1.09% to +1.21%, with isolated higher maxima documented. ([#549](https://github.com/openclaw/fs-safe/pull/549))
- Reuse scratch storage between fallback SHA-256 operations, retaining at most four idle buffers of up to 256 KiB each. Clear used contents before retention and keep each pending read's storage exclusive until settlement, including cancellation; preserve byte limits and borrowed descriptor cursors. ([#550](https://github.com/openclaw/fs-safe/pull/550))
- Share Windows drive and namespace syntax checks without rewriting whole inputs during network classification. Predicate measurements showed gains for normal Windows paths under Linux with explicit Windows rules and a small rooted-alias cost; they do not establish end-to-end Windows throughput. ([#539](https://github.com/openclaw/fs-safe/pull/539))
- Omit `.d.ts.map` output and package entries whose targets are unpublished TypeScript sources, and make package validation reject those maps. The PR's baseline/candidate comparison measured a 5.8% smaller compressed package and 7.8% smaller unpacked package; declarations and public exports remain intact. Thanks @vincentkoc. ([#570](https://github.com/openclaw/fs-safe/pull/570))

### Maintenance and platform validation

- Consolidate archive staging, directory admission, temporary ownership, synchronous store receipt chains, lock registration and acquisition, and ordered mutation-denial policy. Preserve authority boundaries, exact identity checks, callback ordering, stale recovery, and publication/cleanup ownership. These are maintenance changes; measured raw-lock overhead and other control tradeoffs remain documented in their PRs. ([#535](https://github.com/openclaw/fs-safe/pull/535), [#537](https://github.com/openclaw/fs-safe/pull/537), [#538](https://github.com/openclaw/fs-safe/pull/538), [#542](https://github.com/openclaw/fs-safe/pull/542))
- Specialize private lock, store, JSON retry, filename, rename, and move-cleanup helpers to their existing callers; remove unused descriptor projections and native lock-handle methods. Preserve public defaults, shared validators, Windows device-name protection, root replacement checks, and trash fallback behavior. Share write-policy callback types without changing emitted JavaScript or public type semantics. ([#551](https://github.com/openclaw/fs-safe/pull/551), [#552](https://github.com/openclaw/fs-safe/pull/552), [#556](https://github.com/openclaw/fs-safe/pull/556), [#558](https://github.com/openclaw/fs-safe/pull/558), [#546](https://github.com/openclaw/fs-safe/pull/546), [#543](https://github.com/openclaw/fs-safe/pull/543))
- Share guest Python operand admission and descriptor cleanup, retain native POSIX beneath-open descriptors until handoff, and use the shared Windows handle owner for process tokens. Simplify native task settlement, SHA-256 worker state, and Unix cleanup forwarding while preserving containment, positioned reads, cancellation checks, handle ownership, and error precedence. ([#540](https://github.com/openclaw/fs-safe/pull/540), [#541](https://github.com/openclaw/fs-safe/pull/541), [#535](https://github.com/openclaw/fs-safe/pull/535), [#555](https://github.com/openclaw/fs-safe/pull/555), [#565](https://github.com/openclaw/fs-safe/pull/565))
- Use existing Windows SDK declarations for native syscalls and verify the built addon's imports in installed npm and pnpm consumers. Share native link/rename admission and the archive entry schema; simplify Windows relative-open policy while preserving source-before-target errors, manifest snapshots, reparse checks, exact created-directory ownership, and hardlink access. ([#563](https://github.com/openclaw/fs-safe/pull/563), [#560](https://github.com/openclaw/fs-safe/pull/560), [#564](https://github.com/openclaw/fs-safe/pull/564), [#559](https://github.com/openclaw/fs-safe/pull/559))
- Keep filesystem fixtures and backend settings alive until timed-out operations settle, make the in-flight archive deadline regression deterministic, and exercise queue recovery where directory synchronization is unsupported. Send guest-test stdin only to operations that consume it and give the durable copy-restoration regression its instrumented Windows budget. Expand public mutation proof selection to shared policy/path owners without weakening runtime deadlines or settlement assertions. ([#553](https://github.com/openclaw/fs-safe/pull/553), [#556](https://github.com/openclaw/fs-safe/pull/556), [#549](https://github.com/openclaw/fs-safe/pull/549), [#543](https://github.com/openclaw/fs-safe/pull/543), [#540](https://github.com/openclaw/fs-safe/pull/540), [#538](https://github.com/openclaw/fs-safe/pull/538))

## 0.17.0 - 2026-09-20

### Highlights

- **Complete writes and exact comparison for borrowed files:** add `writeFileWindowFully()` and `sameFileContentsSync()` under `/advanced`. Complete short writes with cancellation and per-write authority checks, or compare regular-file descriptors byte for byte with bounded memory and optional byte limits. Callers retain handle ownership and path admission. ([#524](https://github.com/openclaw/fs-safe/pull/524))
- **Explicit archive permissions and reliable selection:** add `extractArchive({ entryUmask })` to remove selected permission bits from extracted files and directories. JavaScript ZIP filters now follow physical archive order, and extraction enforces deadlines even when synchronous work delays timer delivery. ([#516](https://github.com/openclaw/fs-safe/pull/516), [#521](https://github.com/openclaw/fs-safe/pull/521), [#522](https://github.com/openclaw/fs-safe/pull/522))
- **Stronger checks at mutation boundaries:** revalidate Root paths and private-file permissions after caller callbacks, retain exact identities through copy-and-remove moves, and keep synchronous JSON staging bound to its descriptor through publication and cleanup. Replaced entries remain protected. ([#498](https://github.com/openclaw/fs-safe/pull/498), [#500](https://github.com/openclaw/fs-safe/pull/500), [#503](https://github.com/openclaw/fs-safe/pull/503), [#497](https://github.com/openclaw/fs-safe/pull/497), [#527](https://github.com/openclaw/fs-safe/pull/527))
- **Less repeated work in targeted workloads:** reduce ZIP scanning and name admission, TAR path validation, directory-walk allocations, store setup, and default lock-payload decoding. Performance results are workload-specific; archive and other control cases with measured costs remain documented in the linked PRs below.
- **More reliable deep paths and native loading:** resolve valid deep relative paths without JavaScript argument-limit failures, and select the matching native prebuild on Linux installations containing both glibc and musl loaders. ([#523](https://github.com/openclaw/fs-safe/pull/523), [#526](https://github.com/openclaw/fs-safe/pull/526))

### Compatibility and upgrade notes

- `entryUmask` defaults to `0`, preserving existing extraction modes. It applies after `entryModes` to files, explicit directories, and implicit parents, including existing destination subdirectories; it does not change the destination root or private staging modes. The library neither reads nor changes the process umask. See the [archive permission contract](https://github.com/openclaw/fs-safe/blob/v0.17.0/docs/archive.md).
- The new borrowed-file helpers do not acquire locks or provide path admission, identity validation, truncation, durability, or cleanup. Numeric write positions preserve the cursor and require handles opened without append mode; `null` advances the current cursor. Comparison preserves both cursors and is not a snapshot of concurrently modified files. See [borrowed-handle writes](https://github.com/openclaw/fs-safe/blob/v0.17.0/docs/advanced.md#borrowed-handle-writes) and [exact comparison](https://github.com/openclaw/fs-safe/blob/v0.17.0/docs/file-contents.md).
- Atomic copy fallback and copied moves require exact bigint identity observations; injected filesystem adapters must honor `{ bigint: true }`. Rounded or persistently unknown identities fail closed. A copied move can report `ESTALE` after publishing the destination while preserving changed source entries; it is not a transaction or rollback guarantee. ([#512](https://github.com/openclaw/fs-safe/pull/512), [#527](https://github.com/openclaw/fs-safe/pull/527))
- Pathname hashing and portable create-only writes now report owned descriptor-close failures after otherwise successful work. Earlier operation or cancellation failures retain precedence, and a completed destination remains in place after a late close or verification failure. ([#525](https://github.com/openclaw/fs-safe/pull/525))
- Synchronous lock stale-policy callbacks must return synchronously: Promise or thenable results now reject with `TypeError` before deletion. If a protected callback and release both fail, `withFileLock()` and `withFileLockSync()` retain both through `SuppressedError`, with the release failure primary. ([#496](https://github.com/openclaw/fs-safe/pull/496))

### Security and correctness

- Recheck hardlink policy before Root reads return bytes or handles, verify exact identities in the opened-handle path resolver, and capture local-root link policies before asynchronous admission. Explicit link-allow policies remain supported. ([#498](https://github.com/openclaw/fs-safe/pull/498), [#513](https://github.com/openclaw/fs-safe/pull/513))
- Renew directory ancestry and move/removal admission after authority callbacks. Protect replaced roots, copied source files and symlinks, and outside targets; honor callback-triggered removal cancellation before dispatch and preserve the published destination during cleanup failures. ([#498](https://github.com/openclaw/fs-safe/pull/498), [#503](https://github.com/openclaw/fs-safe/pull/503))
- Recheck private POSIX ownership and permissions before mode preparation, after producer and authority callbacks, and through fallback publication. Verify final modes and recheck exclusive-publication source and target identities after directory synchronization, preserving substituted entries and completed destinations on late failure. ([#500](https://github.com/openclaw/fs-safe/pull/500), [#509](https://github.com/openclaw/fs-safe/pull/509))
- Keep synchronous JSON staging descriptor-bound through publication and cleanup, preserving substitutions and staging-name collisions. Compare exact source, destination, and parent identities in atomic copy fallback and mode admission; retain exact move manifests and hardlink groups beyond JavaScript's safe integer range. ([#497](https://github.com/openclaw/fs-safe/pull/497), [#512](https://github.com/openclaw/fs-safe/pull/512), [#527](https://github.com/openclaw/fs-safe/pull/527))
- Capture append content, encoding, mode, and byte limits before filesystem work so changes to caller options cannot change an in-flight write. Empty string appends no longer insert a newline; missing-file creation and durability behavior remain intact. ([#506](https://github.com/openclaw/fs-safe/pull/506))
- Preserve physical ZIP entry order for JavaScript extraction filters, including numeric and Unicode filenames, without changing the public loader's files object. Check archive deadlines at monotonic boundaries, queued mutation dispatch, and successful settlement; retain caller errors and join active destination mutations before rejection. ([#521](https://github.com/openclaw/fs-safe/pull/521), [#522](https://github.com/openclaw/fs-safe/pull/522))
- Keep observed sidecar tokens separate from creator authority, and stop compromise monitoring after manager reset, including checks already in flight. Ownership verification retains raw bytes, token, and identity checks. ([#496](https://github.com/openclaw/fs-safe/pull/496))
- Preserve arbitrary atomic filesystem-adapter failures, including nullish values and throwing error-code getters, and preserve original nullish failures from synchronous symlink-parent checks. Retain missing-file errors from durable queue callbacks, migrations, and owned claim transitions instead of misclassifying them as absent entries. ([#512](https://github.com/openclaw/fs-safe/pull/512), [#514](https://github.com/openclaw/fs-safe/pull/514), [#529](https://github.com/openclaw/fs-safe/pull/529))
- Preserve paired temporary-workspace parent-admission and descriptor-close failures in an `AggregateError`, including on aliases and newly created roots, instead of selecting compatible cleanup or losing the original diagnostic. ([#519](https://github.com/openclaw/fs-safe/pull/519))
- Accept exact bigint directory receipts in durability, exclusive publication, and staging inputs. Returned receipts retain numeric `Stats`, fractional timestamps, and private exact identity authority. ([#495](https://github.com/openclaw/fs-safe/pull/495))

### Performance

- Use bounded signature searches for ZIP end-record admission and entry-count hints, including commented archives. Retain latest-valid-record selection, complete comment and ambiguity checks, conservative count fallbacks, and the dense-marker byte-scan fallback. ([#507](https://github.com/openclaw/fs-safe/pull/507), [#515](https://github.com/openclaw/fs-safe/pull/515))
- Reuse validated nonshared ASCII ZIP names and identical canonical keys while preserving shared-memory revalidation, Unicode Path CRCs, collisions, and decoder metadata checks. Public-loader gains were measured for UTF-8-flagged ASCII names on Node 22/24/26; shallow Unicode controls had a small cost. ([#531](https://github.com/openclaw/fs-safe/pull/531))
- Reuse admitted TAR paths and USTAR components in the shared native/WASM parser, removing redundant allocation and empty-prefix validation. Raw field decoding, padding rejection, and PAX/GNU override checks remain. Linux measurements showed gains for Unicode prefixes, with a small cost on WASM PAX/GNU controls. ([#517](https://github.com/openclaw/fs-safe/pull/517), [#532](https://github.com/openclaw/fs-safe/pull/532))
- Skip unused default JSON decoding during sidecar ownership verification and release. Stale-policy parsing and explicit parser callbacks retain their behavior; gains are concentrated in large structured default payloads, and the measured mixed-workload custom-parser cost remains documented. ([#533](https://github.com/openclaw/fs-safe/pull/533), [lock ownership contract](https://github.com/openclaw/fs-safe/blob/v0.17.0/docs/sidecar-lock.md))
- Reduce repeated bigint metadata allocation in `Root.entries()` and `Root.walk()`, reuse normalized prefixes in standalone walkers, and reduce repeated filename and install-name scans. Preserve exact identity checks, lexical paths, callback timing, cancellation, Unicode limits, and encoded names. ([#510](https://github.com/openclaw/fs-safe/pull/510), [#518](https://github.com/openclaw/fs-safe/pull/518), [#508](https://github.com/openclaw/fs-safe/pull/508))
- Borrow bounded `Uint8Array` stream slices without payload copies, retaining backpressure and byte limits even with shadowed metadata properties. Reuse archive output-parent preparation while each publication still performs fresh parent and source admission. ([#505](https://github.com/openclaw/fs-safe/pull/505), [#499](https://github.com/openclaw/fs-safe/pull/499))
- Reuse synchronous store JSON readers and resolve queue filesystem roots directly. Share filesystem admission and remove redundant ancestor, permission-report, and write-queue work while preserving per-call admission, durability checks, and same-path ordering. These changes include measured control tradeoffs, not a universal latency improvement. ([#501](https://github.com/openclaw/fs-safe/pull/501), [#529](https://github.com/openclaw/fs-safe/pull/529))

### Platform support and validation

- Mark native POSIX beneath-open and duplicated descriptors close-on-exec atomically, preventing child-process inheritance. Preserve caller record locks during macOS ACL inspection, and share Windows secure-file handle ownership without changing borrowed descriptor lifetime or cursor position. ([#504](https://github.com/openclaw/fs-safe/pull/504), [#530](https://github.com/openclaw/fs-safe/pull/530))
- Prefer the running executable's ELF interpreter over installed compatibility-loader filenames when Linux process reports cannot identify libc. Resolve deep valid relative paths without spreading components into function arguments, retaining complete validation and containment checks. ([#526](https://github.com/openclaw/fs-safe/pull/526), [#523](https://github.com/openclaw/fs-safe/pull/523))
- Correct creation examples, advanced helper signatures, Root option references, homepage primitive names, and documentation of Windows payload writes versus native sidecar publication. Accept Corepack's native pnpm 12 launcher in package validation and correct Crabbox argument forwarding. ([#528](https://github.com/openclaw/fs-safe/pull/528), [#502](https://github.com/openclaw/fs-safe/pull/502))
- Strengthen error-code declaration checks and installed archive-consumer proof; repair parent-swap coverage and streamed-create diagnostics, retire superseded package smoke coverage, and measure portable codecs and Windows security fallbacks in native-off benchmarks. Isolate descriptor-close tests from inherited subprocess locks and native-loader tests from real diagnostic-report generation. ([#528](https://github.com/openclaw/fs-safe/pull/528), [#520](https://github.com/openclaw/fs-safe/pull/520), [#529](https://github.com/openclaw/fs-safe/pull/529))

## 0.16.0 - 2026-09-19

### Highlights

- **Private files and directories through existing APIs:** add `private: true` to Root `mkdir()`, `ensureRoot()`, `create()`, and `createJson()`, with verified owner-only permissions and creation-time Windows ACL protection. New `/advanced` helpers `createDirectory()`, `createDirectorySync()`, and `createFileSync()` create one exclusive entry under an existing trusted parent; the file helper returns an owned, disposable descriptor. ([#487](https://github.com/openclaw/fs-safe/pull/487), [#482](https://github.com/openclaw/fs-safe/issues/482))
- **Safer secret and private writes:** verify the actual staging permissions before writing content, rejecting filesystems that accept permission changes without enforcing the required private mode. ([#491](https://github.com/openclaw/fs-safe/pull/491), [#493](https://github.com/openclaw/fs-safe/pull/493))
- **Atomic buffered file creation:** opt into `atomic: true` on `Root.create()` or `createJson()` to keep the destination absent until its content is ready, including without the native addon. Independently select `durable: "file"` when file-flush failures must propagate. Existing defaults remain unchanged. ([#486](https://github.com/openclaw/fs-safe/pull/486))
- **Compressed TAR without native installation:** extract and read bounded entries from zstd and bzip2 TAR archives through bundled WASM codecs, even with all optional dependencies omitted. The fallback retains the shared Rust TAR parser, full-stream validation, byte limits, and guarded publication, with no runtime interpreter or download. ([#488](https://github.com/openclaw/fs-safe/pull/488))
- **Windows security operations without the addon:** use packaged, readable PowerShell/C# helpers for raw owner/DACL inspection, private-directory creation, and secure-file reads in native `auto` or `off` mode when capabilities are unavailable. Private permissions apply at creation, and secure reads inspect the same open handle that supplies the bytes. ([#476](https://github.com/openclaw/fs-safe/pull/476))

### Compatibility and upgrade notes

- Private creation on macOS requires the matching native helper's ACL-inspection capability; disabled, missing, or older helpers reject before creating parents or stages. Relevant inheritable parent ACLs reject creation, while noninheriting ACLs remain allowed. Existing entries are never repaired or made less restrictive. Nonprivate creation and native-free secret-file writes retain their behavior; see the [creation contract](https://github.com/openclaw/fs-safe/blob/v0.16.0/docs/creation.md) for supported modes and platform limits.
- Native-free `atomic: true` creation requires hardlinks and rejects unsupported filesystems without publishing partial content. Private Windows file publication also requires hardlinks on the same local filesystem. Streamed creates continue to stage complete content; atomic visibility does not strengthen pathname containment or guarantee crash durability.
- `durable: "file"` applies to buffered, streamed, and JSON creates and propagates file-sync errors, including `EPERM`. Parent-directory synchronization remains best-effort, independently of the selected publication strategy.
- Windows fallbacks require system PowerShell and permission to run the packaged scripts and `.NET Add-Type` under normal system policy. They emit a path-free `FS_SAFE_NATIVE_FALLBACK` warning once per capability per process and add startup and compilation overhead; disallowed execution fails closed. No system policy is bypassed.
- Native `require` remains strict, and failures from available native operations never trigger a fallback retry. No-clobber `Root.move()` still requires native support. ZIP fallback still needs optional `jszip`, and `inspectTarArchive()` continues to accept only plain TAR and gzip.
- Atomic, streamed, and private creation can report cleanup, close, mode, or synchronization errors after a complete file has been published. Preserve the publication and cleanup receipts when handling failures; completed destinations remain in place, and indeterminate outcomes retain names for recovery.

### Security and correctness

- Verify `0600` before secret-file payload writes in native and JavaScript writers. Verify actual native private-file ownership and permissions before payload writes and at publication, rejecting filesystems that accept permission changes without enforcing them; retain explicit final modes and public staging's `0600` guarantees. ([#491](https://github.com/openclaw/fs-safe/pull/491), [#493](https://github.com/openclaw/fs-safe/pull/493))
- Compare exact directory identities before and after durability syncs, retry unknown Windows observations once, and reject rounded or unverifiable caller receipts. Bind numeric metadata to the same observation and preserve private identity authority across receipt mutation, durable creation, publication, and retained staging. ([#483](https://github.com/openclaw/fs-safe/pull/483))
- Retain streamed `Root.create()` authority callbacks and abort signals across producer waits so replacing caller options cannot detach a revoked lease or redirect cancellation; preserve callback receivers and owned-stage cleanup. ([#490](https://github.com/openclaw/fs-safe/pull/490))
- Recheck retained parent and staging identities after final publication authority callbacks on JavaScript and native writers, preserving substituted entries before their bytes can be published. Flush native Windows creation through the retained writable descriptor and preserve published destinations after finalization failures.
- Snapshot `Root.move()` mutation policy before asynchronous admission so changes to caller-owned deny paths or prefixes cannot change an in-flight move. Recheck native no-clobber source identity, type, and hardlink policy after the final authority callback; live revocation remains available through `assertBeforeMutation`.
- Keep asynchronous Root-backed file locks waiting through successive owner handoffs instead of failing with `path-mismatch`, while retaining identity checks and requiring a fresh exclusive acquisition.
- Return one unsupported clone-metadata result per input without the native addon on non-macOS platforms in `auto` and `off` modes. Preserve input validation, strict `require` mode, and native-only APFS metadata on macOS. ([#489](https://github.com/openclaw/fs-safe/pull/489))

### Diagnostics and maintenance

- Address Windows security commands by their built-in module names and restrict discovery to PowerShell's bundled system modules, avoiding broad discovery scans on helper startup. ([#484](https://github.com/openclaw/fs-safe/pull/484))
- Clarify that `resolveExistingPathsWithinRoot()` permits missing paths while `resolveStrictExistingPathsWithinRoot()` requires existing regular files, and distinguish native beneath mechanisms from the best-effort containment reported by public Root open, read, and writable-open results. ([#485](https://github.com/openclaw/fs-safe/pull/485))
- Honor case-insensitive Windows build environment names so configured WASM compilers and archivers remain selected in worker processes; preserve child-only compiler flags without duplicate case variants. ([#492](https://github.com/openclaw/fs-safe/pull/492))
- Refresh JavaScript and Rust dependencies, pnpm, CodeQL, and archive/release build toolchains, including current NAPI interoperability fixes; retain Node 22 support and Rust 1.88 compatibility. Includes the Dependabot updates in [#481](https://github.com/openclaw/fs-safe/pull/481).

## 0.15.0 - 2026-09-18

### Highlights

- Enforce Root authority throughout synchronous lock admission, stale recovery, and cleanup; keep asynchronous reclaim guards inside the Root capability.
- Preserve directory and archive-source identity across publication, callbacks, and recovery, and reject corrupt portable ZIP payloads and metadata.
- Support asynchronous walk filters, configurable-depth suffix probing, and bounded synchronous descriptor copying.

### Compatibility and upgrade notes

- Directory replacement now requires compatible native identity-fenced, no-replace support, including when the destination is absent. Disabled, missing, or older helpers reject before target-parent creation.
- Treat ordinary post-dispatch native rename errors as indeterminate. Preserve staged files and directory backups when a rename may have committed before its reply was lost; automatic retry and rollback require explicit evidence that dispatch never occurred.
- Synchronous Root locks require a genuine registered Root handle and enforce its policies. Interrupted asynchronous Root reclaim guards can remain after process exit or reset; recover them only after an application-owned liveness check proves the attempt ended.
- Root lock authority checks add measurable overhead. Removing redundant observations reduces some cost, but these paths remain slower than the earlier implementation that did not enforce the same boundary.

### Security and correctness

- Serialize sidecar admission across raw and Root-based synchronous callers, retain separate cleanup authority, and recheck asynchronous authorization at the final stale-removal boundary.
- Keep asynchronous Root reclaim-guard creation, token/byte ownership checks, and removal inside the capability. Preserve unsettled guards instead of following replaced parents through raw cleanup.
- Create native Root lock records through retained-parent exclusive opens so racing contenders retry normally. Ordinary Root writes retain private staging. Treat raw reclaim guards disappearing or changing during collision inspection as contention.
- Verify reclaim-guard ownership after the final sidecar snapshot and parser, preserving mutation authorization and parser failures. Evaluate stale age after snapshot parsing and reject cleanup when exact identity is unknown.
- Retain source-root and child-directory authority during archive merges and bind file identity and mode to the admitted copy descriptor, including exact large Windows identities.
- Preserve ZIP payloads and physical entry metadata during portable loading so extraction rejects corrupt empty content and honors admitted directory, symlink, and special-file kinds without reordering callbacks.
- Snapshot FileStore policies before asynchronous work, streams, source reads, and JSON serialization; snapshot JsonStore durability/newline options before queued mutations and updater callbacks.
- Snapshot external-output and sibling-temp options before asynchronous setup while preserving callback receivers.
- Enforce Windows native parent mutation policies before creating each missing component and retain originating native descriptor ownership through cleanup.
- Preserve files and symlinks replacing an observed empty FileStore directory, and leave directories that become nonempty untouched.
- Recheck child entries before walk descent so symlink replacements during filters honor the selected policy.
- Keep Windows owner/ACL diagnostics bounded and fail-closed for hostile thrown values. Preserve ordinary diagnostics and the original cause without invoking getters, proxy traps, coercion, or altered buffer properties.

### APIs and failure handling

- Allow asynchronous `include`/`descend` callbacks in `walkDirectory()` and `entryFilter` in `Root.walk()`, retaining serial selection, callback receivers, budgets, cancellation, and post-callback identity checks.
- Add `maxDepth` to `probePathSuffixAliasesSync()` with proportional budgets, a 32,768-forward-observation ceiling, unchanged defaults and string limits, and complete owned cleanup.
- Add `copyFileDescriptorSync()` for bounded positional transfers between caller-owned regular-file descriptors, preserving cursors, destination suffixes, descriptor lifetime, and caller-owned durability/publication.
- Preserve the first tree-copy operation failure, including falsy values and existing codes, while closing each owned resource once. Successful operations retain output-before-input and source-before-parent close-failure precedence.
- Preserve falsy atomic operation, cleanup, close, restoration, temporary-workspace removal, and Windows native cleanup failures; consume retained handles before close to prevent repeated release.
- Propagate portable ZIP fallback-close failures before publication and copy-fallback writer close failures after successful unsynchronized writes, including restoration with an absent destination.
- Preserve synchronous destination-admission failures when best-effort close also fails, and preserve directory-mode authority/deadline failures before and after dispatch.

### Performance and maintenance

- Bound path-prefix queue consumption on long paths while preserving short-path behavior and resolution checks.
- Reuse eligible Windows parent-creation receipts, equivalent Root identity observations, and guarded regular-file unlink paths while retaining final identity and policy checks.
- Consolidate native copy ownership, regular/secret read admission, copy-fallback admission, and temporary-workspace setup and settlement; remove redundant wrappers, write-admission storage, and permission-diagnostic work.
- Bind public copy, ZIP extraction, atomic settlement, and permission benchmarks to verified workload receipts; keep setup, content checks, and cleanup verification outside timing.
- Update @napi-rs/cli to 3.10.0 and the locked Node type definitions to 26.6.0, and align Vitest/coverage on 5.0.1.
- Expand security-owner coverage to native/archive code, platform packages, executable benchmarks, and build/test/release configuration.
- Raise publication and release-proof job ceilings to 90 minutes, retaining bounded registry retries and fail-closed artifact, signature, and provenance checks.

## 0.14.0 - 2026-09-17

### Highlights

- **Safer guest directory selection:** descriptor-relative listings now report regular files as well as directories without following symlinks, so consumers can select files without reopening path-type checks.

### Filesystem boundaries and performance

- Report both directory and regular-file kinds from descriptor-relative guest listings. Symlinks and special entries report neither kind.
- Reduce repeated filesystem observations during policy-bound native parent creation, Windows compatibility writes and metadata reads, synchronous store-directory permission repair, and missing temporary-root creation. Fresh identity, canonical-path, lock-destination, callback, and publication checks remain at mutation boundaries.

### Validation

- Register the path-prefix and synchronous `lockRoot` performance workflows on the default branch. Their dispatch stubs fail closed without checking out or executing repository code.

## 0.13.1 - 2026-09-16

### Highlights

- **Correct native cleanup in Node workers:** guarded writes, moves, and staged-file cleanup close native-created descriptors through their originating binding, eliminating unmanaged-descriptor warnings while preserving Node's own descriptor tracking. ([#438](https://github.com/openclaw/fs-safe/pull/438))

### Fixes and compatibility

- Retain the correct closer through errors and native-mode changes, including staged files whose parent directory was opened by Node. Borrowed handles keep their caller-owned lifetime.
- On Windows, close exported descriptors through the same host runtime's libuv table that opened them. Descriptor-producing operations require complete native close support before allocation; stale helpers are treated as unavailable under the existing native-mode policy.
- Add real Worker coverage on Node 22/24 and verify that Windows native close releases both file and directory descriptors. Forced `Worker.terminate()` reclamation remains a [documented limitation](https://github.com/openclaw/fs-safe/blob/v0.13.1/docs/native-helper.md); callers should close retained resources and finish in-flight work before termination.

## 0.13.0 - 2026-09-16

### Highlights

- **Stronger protection against filesystem replacement races:** bind Root reads, metadata, writes, moves, and cleanup to exact file and directory identities; use atomic native rename for no-clobber moves.
- **Less overhead in guarded writes and archives:** avoid repeated path and mutation-policy work on eligible routes, reuse validated archive paths, and size native result buffers to bounded member sizes.
- **Safer Windows paths and writes:** reject NTFS stream and directory-index aliases before filesystem access, and retain destination handles through compatibility writes and verification.
- **New tools for prospective paths:** add `resolvePathPrefixSync()` and `probePathSuffixAliasesSync()` for existing-prefix traversal and bounded observations of missing suffix aliases.
- **Opt-in bounded temporary-file cleanup:** add retained-directory cleanup ownership to `tempFile()` and strengthen temporary-workspace admission and permission repair.

### Compatibility and upgrade notes

- **No-clobber `Root.move()` now requires usable native support.** With `overwrite` omitted or `false`, native-off mode, missing bindings, or unavailable safe parent/rename support fail with `helper-unavailable`; there is no JavaScript check-and-replace fallback. Keep the matching native package installed for these moves. Directory moves still require `overwrite: true`, which retains guarded JavaScript support; use it only when replacement is intended. Post-operation verification can report an error after a rename has completed.
- Windows alternate-data-stream and directory-index aliases now reject across guarded APIs before I/O. Supported rooted and extended-drive paths retain their handling, as do released drive-relative forms in trusted-path atomic, store/queue, move, publication, and lock APIs. Existing Root destination restrictions remain distinct; ordinary colon-bearing POSIX names keep their established rules.
- POSIX secure-file ownership checks now use the process's effective user ID and fail closed when required identity facts are unavailable. Public `Stats` values remain numeric; exact writable-file verification uses private bigint receipts.
- `tempFile({ cleanupSafety: "require-bounded" })` is opt-in and requires an existing supplied root plus supported retained-parent cleanup. Unsupported admission fails before child creation. `"compatible"` remains the default; cleanup callbacks and error-suppression behavior are preserved. Bounded cleanup retains the documented [POSIX final-entry unlink limitation](https://github.com/openclaw/fs-safe/blob/v0.13.0/docs/temp.md).
- The two new path helpers are observations, not permission to access a path. Prefix resolution is read-only but is not a pinned or consistent snapshot. Suffix probing can create and remove directories under an approved writable parent, returns `undefined` when unresolved, and may preserve artifacts whose ownership cannot be verified; its budgets limit work counts and path sizes, not elapsed time.

### Root boundaries and mutation performance

- Fence Root content reads, metadata observations, directory entries, and low-level file opens with exact captured-root, parent, and final-path identities. Admit supported native Windows root spellings without relaxing symlink or replacement rejection.
- Apply `denyMutations` and mutation-symlink policy to the actual retained parent used by `Root.write`, `Root.create`, `Root.copyIn`, `Root.openWritable`, `Root.append`, and `Root.mkdir`, including Windows buffer fallbacks. Admit missing components before creating them, and re-authorize followed final-link destinations before open, truncation, staging, and publication.
- Reuse operation-local policy observations, canonical parent guards, post-create receipts, and immutable suffix offsets for eligible Node.js mutation paths. This avoids repeated resolver work and depth-quadratic segment copies; collisions, callbacks, aliases, ambiguous routes, incomplete identity observations, and final open/publication/cleanup checks retain full admission.
- Bound repeated resolver work during deep missing-parent creation on eligible Windows and POSIX JavaScript paths. Advance only through owned directory-creation receipts, and let `Root.mkdir` reuse an exact existing-parent proof for its single missing child.
- Reuse an already admitted parent guard for private producer Roots while preserving isolated handoff, including legacy Windows delete-pending and read-only restoration behavior.
- Bind nonrecursive removal to its admitted parent and revalidate native move endpoints and explicit parent-symlink rejection before dispatch. Recheck copied-directory identities after child cleanup so concurrent replacements are preserved.

### Credentials, permissions, and temporary files

- Snapshot secure-read, secret-reader, traversal, and borrowed-transfer policies before asynchronous work, including size/link limits, trusted directories, and selected environment values. In-flight admission can no longer be relaxed by changing shared options.
- Preserve single-read pathname and authority accessors on Node.js 22, along with callback receivers, cancellation signals, and progress callbacks across JSON, durable directory/queue, sibling-staging, and borrowed-handle operations. Windows temp admission remains active with platform adapters, and canonical prefixes are checked before inspection.
- Bind secure temporary-directory and synchronous store-directory mode repairs to no-follow descriptors and exact current identities, including concurrent mode changes during the matching-mode fast path.
- Admit temporary-workspace roots and children before use, preserve existing permissions, and bind initialization and cleanup to retained identities. Opt-in bounded temporary-file admission closes descriptors on failure.
- Retain Windows destination descriptors through buffered compatibility-write locking, content verification, mode changes, sync, and final identity checks.
- Validate descriptor-bound macOS clone ACLs before admission and publication, including absent ACLs. Once payload bytes exist, normalization or security failures are terminal `EIO` errors rather than a reason to retry with an ordinary copy.

### Archive safety and performance

- Bind physical ZIP entry names and file/directory kinds to decoder metadata before callbacks or member selection, rejecting ambiguous interpretations consistently.
- Stop zstd and bzip2 compressed-input refills after cancellation while preserving decoded-output limits and complete archive validation.
- Reuse canonical archive paths when no components are stripped and avoid temporary ZIP collision collections, retaining validation/filter order and checks of both raw and Unicode identities.
- Reserve native archive result capacity from bounded member-size hints so small ZIP and compressed TAR reads do not allocate the caller's larger byte budget.

### Path helpers and reliability

- Add [`resolvePathPrefixSync()`](https://github.com/openclaw/fs-safe/blob/v0.13.0/docs/path-prefix.md) under `@openclaw/fs-safe/advanced` to traverse existing path prefixes while retaining the raw missing suffix, preserving dangling aliases and propagating ambiguous resolution failures.
- Add [`probePathSuffixAliasesSync()`](https://github.com/openclaw/fs-safe/blob/v0.13.0/docs/path-suffix-aliases.md) under `@openclaw/fs-safe/advanced`, with fixed path, depth, creation, and observation budgets and conservative identity-checked cleanup.
- Sanitize fallback filenames and validate completed sibling callback names before producers run, retaining length bounds and Windows device-name rejection. Reuse Windows namespace admission for unchanged ordinary rooted-drive paths while keeping full checks for relative, normalized, malformed, namespaced, and colon-bearing forms.
- Pin asynchronous relative sidecar-lock paths and roots to their entry-time working directory through acquisition, reclaim, verification, and release. Close synchronous lock descriptors after metadata inspection failures while preserving the original error and unverified sidecar; retry vanished admitted successors under the existing identity checks and budgets.
- Report actionable guarded-write errno diagnostics while preserving error codes, categories, original causes, and already-classified failures.
- Tolerate concurrent guest parent-directory creation only after descriptor-relative no-follow admission; file and symlink competitors remain rejected. Thanks @vincentkoc.
- Show only the moon icon in the docs light-theme picker and only the sun icon in dark mode.

### Validation and tooling

- Strengthen exact-identity, rounded-inode, Windows recovery, mutation-policy, and package-consumer regressions, with explicit test-hook provenance and bounded fixture lifetimes. Queue stress fixtures retain and drain outstanding writers before cleanup.
- Separate manual method-audit harnesses from immutable candidate and baseline checkouts, validate dispatch inputs before fan-out, and support Node 22/24 plus rebuild and same-artifact controls. Versioned benchmark receipts bind source, harness, dependencies, artifacts, native addons, and runner metadata; they detect accidental drift and are not a sandbox for hostile code.
- Expand benchmark coverage for filename sanitizers, all 17 profiles, shared mutation admission, temporary-workspace modes, and existing/missing roots at depths 4/8/32. Keep Windows-specific rows and observed-preservation claims distinct from JavaScript operation counts.
- Isolate split-credential proof runners, authenticate official Node archives before checkout, and use private, identity-checked stages and tools. Fixtures remain traversable by both dropped identities while published receipts stay in a separately admitted container; the seven behavioral cases are unchanged.
- Update development tooling to `@napi-rs/cli` 3.9.1, fast-check 4.10.0, and Vite 8.3.0 with verified registry integrity.

## 0.12.0 - 2026-09-15

### Highlights

- **Faster archive workloads:** reuse validated ZIP names, batch native plain-TAR reads, and reduce gzip validation and payload-buffer allocations while preserving complete archive checks.
- **Less overhead in everyday filesystem work:** reduce repeated path resolution, directory-walk work, small-hash allocations, Linux copy buffers, and lock-manager setup.
- **Stronger Windows file boundaries:** verify secure-file permissions against the descriptor supplying the bytes, retain handles through private-directory creation and cleanup, and check directory identity when Root containment relies on case folding.
- **Safer queue recovery and cleanup:** prevent stale migrations from replacing newer queue entries, preserve files refreshed during expiry pruning, and keep existing destinations intact when guest symlink moves fail.
- **Versioned install identifiers:** add `safePathSegmentHashedV2`, which hashes every trimmed ID into a fixed lowercase directory segment and avoids the deterministic aliases of the legacy readable encoder.

### Compatibility and upgrade notes

- Windows `readSecureFile()` now requires the matching current native package for descriptor-bound owner and DACL checks. Missing or stale helpers, remote handles, denied access, and unsupported or incomplete permission facts fail closed before reading; there is no pathname ACL-command fallback. Standalone permission-reporting APIs retain their documented fallbacks.
- Windows private-directory creation rejects explicit `.` and `..` components and components ending in spaces or periods before filesystem operations. Directory association requires the complete file identity; unsupported identity classes fail closed.
- Windows native descriptor operations require the host runtime's paired libuv descriptor bridge. Missing or partial bridges reject with `ENOTSUP` instead of interpreting descriptors as raw handles or using another runtime's descriptor table.
- `safePathSegmentHashedV2` is opt-in. Legacy encoder outputs and the default encoder remain unchanged. Switching to V2 changes existing paths: use a new base directory or explicitly migrate after verifying recorded IDs, and do not silently fall back to legacy paths.

### Archive performance and reliability

- Reuse identical local and central ZIP name validation within one entry, including matching complete Unicode Path metadata. Differing fields and shared backing memory retain independent checks; CRC, traversal, collision, and interpretation validation remain intact.
- Reuse raw archive path segments during validation, preserving platform rules, normalized component limits, and error ordering.
- Speed up native plain-TAR inspection and extraction with bounded file read-ahead, retaining complete framing, payload, trailer, and cancellation checks at parser boundaries.
- Fill one owned result buffer when reading admitted gzip TAR payloads in JavaScript, reducing retained decoded buffers while preserving complete validation and independent returned bytes.
- Validate gzip container padding with bounded buffer comparisons and one lazily allocated reusable zero window, preserving complete suffix checks, short-read handling, and cancellation cadence.
- Destroy and join ZIP decoder sources before rejecting bounded member reads, preventing abandoned decoders and retained archive buffers after byte-limit failures while preserving error classifications on Node 22 and newer.

### Paths, reads, and copying

- Reuse normalized absolute POSIX roots within bulk lexical path resolution and avoid per-segment drive-letter validation allocations, preserving path spellings, validation order, and errors.
- Reuse resolved Windows drive paths and descendant comparisons, with existing namespace, UNC, and colon-bearing component handling retained. Classify Windows device names without intermediate segment arrays.
- Reuse lexical directory prefixes while walking, preserving traversal order, followed-link spelling, budgets, callback behavior, and directory checks.
- Size small JavaScript SHA-256 scratch buffers to the file and byte budget, growing when size hints are stale while preserving complete reads, overflow detection, cancellation, and borrowed-descriptor ownership.
- Complete positive short reads from virtual files that report size zero instead of returning a truncated prefix. Byte-limit overflow detection and borrowed-descriptor cursor behavior remain intact.
- Confirm EOF when Linux `copy_file_range` reports zero after partial progress; resume guarded byte copying when readable data remains instead of publishing a truncated copy.
- Size Linux native byte-copy buffers from existing source-size hints, bounded between 4 KiB and 1 MiB, retaining read-to-EOF behavior, sparse output, and borrowed descriptors.

### Windows security and generated names

- Bind secure-file owner and DACL verification to the open descriptor and compare its native volume serial and file-index projection with Node's bigint receipt before reading.
- Retain parent and created-directory handles through private-directory creation, protected-DACL validation, complete identity association, and failure cleanup, preserving concurrent pathname replacements.
- Require differently cased Root prefixes to match the Root directory's exact identity, then continue under its trusted spelling. Exact-case paths retain their lexical fast path.
- Prevent filename truncation and temp-file sanitization from producing Windows reserved-device aliases. Invalid completed sibling callback components reject before hooks or producers run.

### Queues, locks, and cleanup

- Bind durable-queue migrations to their pinned processing generation, rejecting stale callbacks after acknowledgement, quarantine, or replacement. Release the verified read pin at Windows publication so migrations can replace their target.
- Resync resumed processing claims under the transfer lock so conditional migrations cannot bypass a failed publication sync on retry.
- Recheck current file type and modification time immediately before expiry pruning removes a file, preserving fresh replacements and timestamp refreshes without requiring read access.
- Stage guest cross-device symlink moves privately before atomic replacement, preserving the existing destination and source link when creation or publication fails.
- Avoid rescanning held locks during repeated lock-manager construction, and initialize legacy reference counts during acquisition and release so nested handles retain the outer lock.

### Validation

- Expand representative method-audit coverage to 572 workloads across JavaScript/native modes on Linux, macOS, and Windows, including 1,000-entry walks, larger TAR inventories, and small synchronous hashes, with explicit platform exclusions.
- Allow focused method audits with explicit native mode and balanced A-B-B-A or B-A-A-B measurement ordering.
- Extend walker coverage for lexical aliases and callback mutation. Keep cancellation fixture setup outside the operation deadline and drain fixture writes before cleanup on slow or failing filesystems.
- Give the Windows slow physical-package-copy sidecar proof separate setup, operation, child, and teardown budgets with bounded failure diagnostics, preserving ordinary helper deadlines.

## 0.11.0 - 2026-09-14

### Highlights

- **Faster archive-heavy workloads:** reduce repeated ZIP admission, batch native ZIP metadata reads, and reuse TAR parser input and admitted payload ranges. Archive extraction and inspection also benefit from larger reusable staging and transfer buffers.
- **More capable filesystem roots:** iterate one directory with `Root.entries()`, remove trees with bounded or explicitly unlimited `Root.remove()`, and create complete files from async byte streams with `Root.create()`.
- **Reuse handles for copying, overwriting, and hashing:** add `copyFileHandle()`, `overwriteFileHandle()`, and `sha256FileSync()` while preserving caller-owned descriptors and file positions.
- **Faster Windows permissions and copying:** inspect inherited ACLs without PowerShell startup when the native binding is available, reduce copy allocations, and preserve large zero-filled ranges in empty destination files.
- **Safer publication and private files:** tighten hardlink, inode, permission, archive-destination, and lock validation; add private producer workspaces for callback writes and fix staging of long Unicode filenames.

### Compatibility and upgrade notes

- `readSecureFile()` now rejects hardlinked inputs and rechecks the opened file after reading. Synchronous store publication rejects substituted or unverifiable file identities, including opaque Windows identities.
- Invalid lock stale thresholds and compromise-check intervals now reject before acquisition. Asynchronous compromise checks no longer overlap or turn overflowing timer values into rapid polling loops.
- Inherited atomic-replacement modes include only ordinary rwx bits from an existing non-symlink regular file. JavaScript raw sidecars are created with mode `0o600`, so a permissive umask cannot expose their payloads.
- Bun gains additional POSIX path support through the existing Rust binding, including with JIT disabled. Native-off policy remains explicit; addon-free limitations are documented. Node.js remains supported from version 22.

### Directory and file workflows

- Add guarded, nonrecursive `Root.entries()` with child-symlink reporting, cancellation, entry limits, and bounded sorted-name collection. Traversal and link policy remain with the caller.
- Extend `Root.remove()` with recursive traversal, entry/depth budgets, sorted or filesystem order, cancellation, and missing-target handling. Callers may explicitly choose unlimited recursive-removal budgets; exact directory/leaf identity checks remain in place, and `force` continues sibling cleanup when a child directory disappears.
- Add a `Root.create()` overload for async byte iterables. Input consumption is bounded, cancellation settles pending work, and completed contents are published exclusively through the existing guarded writer.
- Add `copyFileHandle()` for bounded regular-file transfers and `overwriteFileHandle()` for in-place replacement with prefix-only rollback preparation, growth-before-overwrite ordering, and a once-only synchronous pre-write admission callback. Both preserve caller ownership and cursors.
- Add `sha256FileSync()` for bounded hashing of pathnames and borrowed descriptors, with exact pathname admission and no native-binding requirement.
- Add exact directory-identity observations and synchronous assertions for caller-owned staging and recovery, retaining bigint precision, optional canonical-path checks, and final-symlink rejection even with trailing separators.
- Add `probePathCaseInsensitiveSync()` for local ASCII-case observations, with a read-only option, owned temporary probes, and an explicit unknown result instead of operating-system guesses.
- Add opt-in `producerIsolation: "private-directory"` to sibling callback writes and external sibling outputs. Cleanup ownership is established before the producer runs, allowing partial failures to be cleaned without changing existing defaults or publication checks.

### Archive and path performance

- Avoid repeating physical ZIP admission during JavaScript member reads. Reduce filename-validation allocations across both backends, and group native ZIP metadata reads into bounded buffers while retaining complete record, CRC, limit, and cancellation checks.
- Copy each JavaScript TAR WASM input window once across member events. Read selected plain-TAR payloads directly from the fully admitted private snapshot instead of parsing it a second time.
- Batch private archive-input staging through reusable buffers capped at 512 KiB. Match file-backed JavaScript gzip output to the 64 KiB WASM input window for faster extraction and TAR inspection; retain short-I/O handling, framing validation, bounded growth probes, and settled cancellation.
- Reduce repeated POSIX path-scoping and Root work, reuse checked store keys, and avoid redundant name normalization. Root exclusion, canonical spelling, Unicode byte limits, collision rules, home expansion, and live filesystem identity checks are preserved.
- Complete short gzip-header reads before classifying staged archives, preventing valid gzip files from being mistaken for TAR.
- Fit callback staging names using their original UTF-8 length as well as NFC/NFD lengths. Valid destination names whose normalization is shorter no longer fail with `ENAMETOOLONG` when a staging prefix is added; the final target spelling is preserved.

### Copy performance and filesystem fidelity

- Batch large borrowed-handle and JavaScript Root transfers through reusable 512 KiB buffers, retaining byte limits, cancellation, and per-write authority checks. Small byte budgets also bound scratch allocation and the overflow probe.
- Batch atomic copy-fallback restore snapshots and synchronous source reads into reusable buffers, reducing reads and full-buffer copies while preserving restore budgets, short reads, identity checks, original modes, and rollback behavior.
- Share portable directory-copy workers across sibling directories, with bounded deferred completion, joined cancellation, and bottom-up timestamp restoration. Preserve fractional timestamps, including pre-1970 dates on Unix, to the precision supported by Node and the destination filesystem.
- Add Linux ZFS directory cloning through the bounded reflink traversal, with independent destinations, metadata preservation, and no byte-copy fallback when cloning is required. XFS clones now preserve user extended attributes on read-only files and directories, along with their modes and ACLs.
- Preserve large zero-filled ranges without allocating them during native Linux automatic directory byte copies and native Windows byte copies into empty files. Exact lengths, contents, cancellation settlement, and existing-target overwrite behavior remain intact.
- Confirm EOF when Linux copy offload initially reports zero bytes, so automatic copying reads available data instead of publishing an empty file.
- Size Windows native copy buffers to small inputs, reuse directory-enumeration buffers, and start ReFS workers as file jobs arrive. Report disk-full and sharing failures as `ENOSPC` and `EBUSY`; worker-start failures join admitted workers before returning instead of panicking across the native boundary.

### Permissions, compatibility, and tooling

- Inspect complete inherited local Windows ACLs through the native descriptor reader when available, preserving SID classification, explicit test injections, .NET normalization, and structured fallback diagnostics. Classify canonical SID facts directly without a redundant account lookup, retaining fail-closed behavior when discovery is unavailable.
- Retain the admitted archive destination's exact bigint identity through publication, rejecting replacements introduced by entry filters or concurrent actors before files can be published into them.
- Support Bun POSIX resolution for restrictive permissions, literal backslashes, sockets, and symlink/parent traversal. Preserve raw path components in absolute recursive-mkdir inputs to fix relative publication and queue writes on Bun for Windows.
- Export the caller-launched Python guest filesystem program and shared no-replace rename fragment through `@openclaw/fs-safe/guest`. The Linux/macOS protocol validates basenames before filesystem operations and uses short independent staging names for long-basename writes and cross-device moves.
- Support standalone `@pnpm/exe` in consumer smoke and lifecycle tests while retaining the declared pnpm version and isolated consumer configuration. Strengthen exact-inode durability checks and batch independent native ACL test observations.
- Expand method benchmarks to 557 representative workloads across Linux, macOS, and Windows, with native/JavaScript modes, equal-concurrency copy comparisons, large collections, contention, and explicit platform exclusions. Verify returned data and digests, initialize private Windows fixture ACLs, apply synchronous iteration reductions consistently, and handle expected synchronous rejections during timed calls as well as warmup.

## 0.10.0 - 2026-09-13

### Highlights

- **Faster ZIP and TAR reads:** read archive members without temporary disk snapshots, reuse admitted native buffers, and reduce integrity-check and decompression overhead while retaining full validation.
- **Directory copies with native acceleration:** use `copyTree` to prefer or require APFS clones, Btrfs snapshots, or parallel ReFS/XFS reflinks, or choose portable byte copying for controlled, immutable templates and checkouts.
- **Guarded file copies:** copy from checked Root sources with exclusive publication, cancellation that waits for writes, and optional native cloning; copied data stays independent of its source.
- **Faster Windows byte copies:** reuse bounded buffers and parallelize directory copying, with native transfers between checked handles in automatic mode.
- **Reuse buffers for file reads:** new async and sync positional readers fill caller-owned buffers without changing the file's current offset; hashing gains byte limits and cancellation.
- **Walk large directories incrementally:** Root walks bound metadata work by the entry budget, with an opt-in filesystem-order stream for directories too wide to enumerate up front.
- **Recheck live access authority:** Root mutations can verify caller-owned leases or cancellation immediately before dispatch, and new symlink policies allow contained parent-directory aliases while rejecting final symlinks.

### Compatibility and upgrade notes

- **Ambiguous paths may now reject.** Reads preserve actual symlink and parent traversal instead of normalizing it away; mutations reject ambiguous symlink/parent combinations. Use the new explicit parent-alias policies when that behavior is intended.
- **Mutation failures are reported more accurately.** Failed parent-directory checks after fallback moves and removals now reject instead of reporting success. Treat rejection after dispatch as a potentially completed mutation, not proof that nothing changed.
- **Windows fallback writes honor durability settings.** Root defaults and per-call overrides now apply to JavaScript write/create fallbacks. Use `durable: false` explicitly for reconstructible data when syncing is unnecessary.

### Archive reads

- Retain admitted ZIP input buffers and parsed directories across native inspection and selected-member reads, removing disk staging and archive handoff copies. JavaScript ZIP reads also consume the admitted in-memory archive directly.
- Retain native TAR input and admitted member offsets. Plain TAR copies only the selected range after complete validation; gzip, zstd, and bzip2 replay bounded decompression with framing, trailer, padding, and limit checks intact. JavaScript TAR/gzip reads also avoid disk staging, with gzip output chunks matched to the WASM input window.
- Accelerate ZIP integrity checks with Node's native CRC32 on Node 22.2 and newer, retaining checksum validation and compatibility with earlier Node 22 versions. Reuse the strict UTF-8 decoder for TAR metadata without changing filename validation or BOM handling.
- Give each native archive pass its own abort signal so completed inspection cannot mask an extraction deadline.

### File reads, hashing, and directory walks

- Add `readFileWindowFully()` and `readFileWindowFullySync()` to fill caller-owned buffers through short reads, stop at EOF, and preserve descriptor offsets and ownership. Async cancellation waits for the pending read to settle before the buffer can be reused.
- Bound speculative allocations for large or exhausted files and accelerate synchronous bounded reads of regular files up to 16 MiB without extra chunk copies; retain one-read async performance through the default Root byte budget.
- Add byte limits and cooperative cancellation to `sha256File`, preserving descriptor ownership and waiting for native work to stop before rejecting. Batch larger JavaScript hash reads in bounded buffers up to 256 KiB to reduce filesystem calls.
- Bound Root walk metadata batches by the global entry budget and stop batches at directories and symlinks before descent. Add `order: "filesystem"` for incremental directory streaming with bounded lookahead; sorted traversal remains the default, and unbounded sorted walks retain fast snapshots.
- Reduce walk overhead by sharing equivalent directory checks and synchronous entry classification, reusing joined paths, and avoiding an extra promise per async entry. Preserve both operation and close failures during disposal, and report a followed symlink target's size consistently in filters and returned metadata.
- Speed up POSIX containment and filename helpers while preserving traversal rejection, Unicode handling, reserved names, and collision-resistant install names.

### File and directory copying

- Extend `Root.copyIn` with guarded Root sources, exclusive publication, settled cancellation, exact publication receipts, and optional native file cloning while keeping copied data independent. Share `clone: "auto" | "always" | "never"` with `copyTree`; Root keeps its `"never"` default, which uses ordinary reads and writes without clone or copy-offload calls.
- Add `copyTree` in `@openclaw/fs-safe/copy` with `clone: "auto"` (default), `"always"`, and `"never"` policies. Automatic copying prefers native cloning and falls back to byte copying only when the binding or filesystem capability is unavailable, or cloning cannot cross filesystems; strict cloning never falls back, and ordinary copying avoids clone and copy-offload calls. Destinations must be absent, and cancellation waits for admitted writes to settle.
- Speed up Windows directory byte copies with bounded parallelism, reusable 1 MiB buffers, and native transfers between checked handles in automatic mode. Honor copy concurrency across portable backends and settle admitted writes before reporting failures or cancellation.
- Support APFS directory clones, Btrfs subvolume preparation and snapshots, and parallel ReFS/XFS reflinks through `probeTreeClone` and `createCloneSource`. Preserve XFS file and directory extended attributes and ACLs, and restore directory timestamps after APFS bulk cloning.
- Add batched `readCloneFileMetadata` for APFS clone IDs and file metadata. These are point-in-time observations, not authorization or proof that later contents remain unchanged.
- Document metadata and filesystem limits: APFS directory cloning does not guarantee descendant ACL preservation or inheritance, Btrfs snapshots omit nested subvolume contents, and ReFS rejects unsupported reparse points and alternate data streams. Portable copying does not promise ownership, ACL, extended-attribute, alternate-stream, or sparse-layout preservation. Callers retain responsibility for source immutability, permission policy, and recovery after a failed or aborted copy.

### Root policies and path safety

- Add composed Root `assertBeforeMutation` callbacks that recheck live caller authority immediately before mutation dispatch, including each buffered-write chunk and direct file removal. Root-level and per-call checks both apply; refusal errors and owned cleanup are preserved across native and JavaScript writers.
- Add `symlinks: "follow-parents-within-root"` for reads and opt-in `mutationSymlinks` policies, following contained directory aliases while rejecting final symlinks at absolute root entry, open, and publication boundaries.
- Preserve checked canonical and raw traversal in Root, absolute-path, local-root, and `openRootFile`/`openRootFileSync` reads, including home expansion and parent components that cancel a missing prefix. Validation can no longer normalize away a rejected link or select a different in-root file; local `requireFile` reads retain final-symlink rejection.
- Pin Root directory identities as bigint values, reject indistinguishable numeric inode replacements, and fail closed after bounded retries when Windows root identity remains unknown. Require a verified opened identity before inheriting an existing write target's mode.
- Preserve Linux native directory-only open flags so the kernel rejects non-directories before FIFO blocking or truncation, while removing the redundant post-open stat.
- Expand leading home-directory prefixes before resolving parent segments, so `~/../file` resolves against the home directory's parent; keep other tildes literal. Shorten only the home directory and its descendants in error messages, preserving similarly prefixed sibling paths.
- Resolve Windows ACL principal names such as `constructor` and `__proto__` as real dictionary keys, preserving SID lookup and translated entries.
- Preserve Unicode Windows paths during fallback permission inspection by reading structured SID and access-mask facts instead of localized command output.

### Writes, moves, and cleanup

- Check the complete encoded newline before Root append, avoiding duplicated or missing separators in UTF-16LE files on Windows and other platforms.
- Preserve unowned staging replacements after Windows fallback write or sync failures, and retain exact parent-directory identities so owned partial-file cleanup works even when Windows directory indexes exceed numeric precision.
- Report failed post-operation parent checks after fallback moves and removals, including moved source parents, instead of silently reporting success.
- Close publication descriptors when initial inspection fails and relinquish descriptor numbers before potentially failing closes, preventing cleanup from closing a reused descriptor.
- Keep move-fallback publication and cleanup tied to the initially admitted staging identity, preserve substituted paths after copy failures, and reject writes that make no progress.
- Preserve recreated temporary paths after exit cleanup observes the original name missing; absence no longer authorizes removal of a later replacement.
- Allow explicitly authorized filesystem-root descendants in Trash moves and keep reservation-directory names bounded for long source filenames.

### Locks and durable queues

- Honor finite timeouts and retry delays above Node's single-timer limit by rearming bounded timers instead of expiring after approximately 1 ms.
- Keep zero-delay lock retries finite when a large backoff factor overflows, preserving retry and timeout budgets.
- Skip invalid delivered-marker names during durable queue batch loading, preserving malformed files while continuing to load valid pending entries.
- Read durable queue entries through the shared bounded buffer and admitted file-size hint, reducing filesystem calls and chunk copies while retaining exact identity and byte-limit checks.

### Validation and maintenance

- Add a method-by-method benchmark with callable API coverage checks, native/fallback reports, and fixture setup outside measurement.
- Give the full documentation-build smoke test a bounded longer runtime on slow Windows runners. Validate retained native archive buffers across concurrent reads and forced garbage collection; use efficient byte comparisons in large-buffer coverage tests without relaxing timeouts.

## 0.9.0 - 2026-09-11

**Highlights:** Faster bulk extraction and configurable durability, with Windows filesystem fixes and reliable mixed-version lock cleanup.

- **Compatibility:** `extractArchive` skips file and directory fsync by default for faster bulk imports; pass `durable: true` to restore the previous durability behavior.
- Add store-level and per-call `durable` options to FileStore writes, streams, copies, and synchronous writes, plus JSON-store defaults, so reconstructible data can skip fsync while preserving guarded atomic publication.
- Add `Root.copyIn({ durable: false })`, with per-call, root-default, then `true` precedence, to skip file and parent-directory fsync for reconstructible data.
- Speed up archive extraction by omitting private staging syncs, deferring opted-in publication durability to one bounded file/directory pass, and sharing duplicate destination guards without weakening containment checks.
- Keep process-exit lock cleanup working when a legacy shared manager lacks reclaim-guard state, continuing through later managers while preserving retained locks; thanks @metahacker.
- Publish read-only modes such as `0o400` through the Windows JavaScript write fallback by retaining private `0o600` staging and applying the final mode through the retained handle after rename.
- Preserve Windows file identity across open-induced `ctime` changes during guarded move fallback, and recreate directory junctions without requiring symlink privileges; thanks @giodl73-repo.
- Extend synchronous metadata observations to archive, copy, publication, move, and directory-mode paths while keeping data and structural I/O asynchronous and preserving native canonical paths.
- Keep durable publication coverage reliable under filesystem contention by allowing bounded I/O time and draining unfinished operations before fixture cleanup.
- Refresh JSZip to 3.10.2, Node declarations to 26.5.1, emnapi runtime build tooling to 2.0.0-alpha.5, the Rust hybrid-array dependency to 0.4.15, and pinned CodeQL actions to 4.38.0.

## 0.8.6 - 2026-09-07

**Highlights:** Clearer guidance for atomic writes on Windows exFAT, with a repeatable filesystem compatibility probe.

- Document the existing opt-in locked rename policy for Windows exFAT/FAT32 and add a built-package probe for identity drift, substitution handling, and temporary-prefix isolation; require a trusted, quiescent probe parent and verify its cleanup identity. Thanks @dongsheng123132.
- Refresh the native zstd decoder to 0.14.0 and compatible Rust and JavaScript development dependencies, and update the pnpm setup action to 6.1.0.

## 0.8.5 - 2026-09-07

### Highlights

- **Strict moves stay strict:** a move started with hardlink rejection keeps that policy throughout asynchronous preparation and copying, even when the caller reuses or changes its options object.

### Safe moves

- Preserve the admitted `sourceHardlinks` policy through staged-copy fallback. A late hardlink is still rejected before destination publication, with the source and its alias preserved, instead of being accepted after an in-flight options change.
- Document when move policy is captured and how it relates to the existing per-mutation authority checks and destination-publication receipts.

## 0.8.4 - 2026-09-07

### Highlights

- **Faster reads and writes:** metadata checks avoid unnecessary event-loop round-trips while data I/O stays asynchronous; reconstructible data can explicitly opt out of fsync with `durable: false`.
- **Inspect TARs without extracting:** the new bounded archive inspection API uses the same native/WASM admission and canonical planner as extraction.

### Filesystem performance and durability

- Run metadata checks inside async operations synchronously (microseconds each), cutting event-loop round-trips per read/write while data I/O remains asynchronous and native canonical path spelling is preserved, including Windows short paths.
- Add `durable` to Root write/create/writeJson/createJson/append options and Root defaults; `durable: false` skips file and parent fsync for reconstructible data (default unchanged: durable).

### Archive inspection and compatibility

- Add bounded `inspectTarArchive` with complete native/WASM admission and the same canonical extraction planner, preserving effective member identities without materializing an output tree.
- Preserve inherited and getter-backed extraction options on the WASM TAR path, matching native and ZIP handling for destinations, filters, stripping, and modes.

### Validation

- Apply the existing filesystem-test worker cap locally as well as in CI, and drain archive publication fixtures before resetting hooks or cleaning restricted directories after timeouts.

## 0.8.3 - 2026-09-06

### Highlights

- **Safer cancellable moves:** callers can guard every source removal and retain an exact destination-publication receipt for recovery after later failures, including Windows and cross-device fallbacks.
- **Less filesystem overhead:** reads and writes make fewer calls while preserving their existing boundary and identity checks.

### Move authority and recovery

- Add optional synchronous move authority checks before renames and each copied-source removal, plus an exact bigint destination-publication receipt for caller-owned recovery after later failure; retain cross-device and Windows `EPERM` copy fallbacks and the existing `Promise<void>` contract.

### Filesystem performance and durability

- Reduce filesystem calls per read and write while retaining boundary, hardlink, hook, retry, and post-mutation identity checks.
- Skip native publication's extra mode-only file fsync for modes that retain owner read/write when staging permissions have not widened; after a crash, a file may retain staged `0o600` instead of the wider requested mode, while restrictive modes retain the extra fsync.

### Tooling and maintenance

- Add 1 MiB read/write and existing-mode inheritance benchmarks, with native-mode metadata and per-case iteration counts.
- Simplify internals without changing public behavior: remove unused string/home helpers, `resolveUserPath`, `createBoundedReadStream`, `sidecarLockPayloadIsStale`, and `tarManifestEntryCost`; share filesystem utilities and merge private modules.

## 0.8.2 - 2026-09-05

**Highlights:** TAR/gzip extraction now shares one parser across native and fallback modes, improving compatibility with system-tar output while keeping admission and publication guarded.

- Reject reserved archive device names and ignored-space aliases on Windows while preserving ordinary POSIX members, and guard secret reads with the documented `device-path` rejection. Thanks @SebTardif.
- Unify native and guarded JavaScript TAR admission on one Rust core, bundle its WASM build, and accept strict UTF-8/newline PAX paths without a runtime `tar` dependency; retain bounded framing, raw-field validation, and guarded publication.
- Accept bounded all-zero gzip container padding from system-tar stdout after validated member trailers, and reject nonzero data hidden after padding on both native and guarded JavaScript TAR routes.
- Fix `replaceFileAtomic({ dirMode })` rejecting a raw `fs.stat` mode: directory modes are masked to permission bits (`0o7777`) before application and verification, matching chmod semantics; 0.8.0 regressed this input tolerance with `directory final mode could not be verified`.
- Standardize malformed TAR mode fields on the native zero fallback while preserving ordinary octal, absent, zero, and safe GNU binary modes.
- Refresh the native binding build tool to `@napi-rs/cli` 3.9.0 and the test/coverage toolchain to Vitest 5.0.0. Thanks @dependabot.

## 0.8.1 - 2026-09-04

- Add `retainOnExit` to sidecar lock acquisition so deliberately retained ownership records (for example fail-closed build locks) survive natural process exit; default process-exit release behavior is unchanged.

## 0.8.0 - 2026-09-04

### Compatibility and upgrade notes

- **Existing secret directories must already have the requested mode.** Wrong permissions now fail the write with `insecure-permissions` instead of being chmod-repaired; audit and fix existing directories before upgrading.
- **FileStore keys are enforced portably.** Parent-segment and backslash aliases are rejected with `invalid-path` across async reads, `exists`, and `remove`, matching the sync and write paths.
- **Lock and queue failures now surface.** Durable queue enqueue, migration, and acknowledgement sync failures propagate instead of returning empty or partial success; sidecar payloads above 1 MiB are rejected with `too-large`; async lock retry counts apply even with infinite deadlines. Handle these rejections explicitly.
- **Create-only visibility is backend-scoped.** The sibling-temp no-visibility guarantee for `create`, `createJson`, and `write({ overwrite: false })` holds with the native binding (`require` mode, or `auto` when the binding loads); the JavaScript fallback claims the final name before content is written.

### Highlights

- **Stricter secret storage:** existing secret directories are never chmod-repaired — wrong permissions fail the write — and directory identity is tracked exactly through private locks and native writes, closing replacement races.
- **Exact file modes everywhere:** explicit modes, including set-ID bits, are applied after content writes and verified in full at publication, and synchronous appends no longer drop bytes when the kernel writes short.
- **Restrictive secret modes work:** write-only and no-access files such as `0o200` and `0o000` publish successfully through the writer's retained descriptor, without a readonly reopen or widened permissions.
- **Resilient locks and queues:** Windows sidecar creation retries genuine denials within the existing budgets, Root-backed locks release on natural process exit, and queue enqueue/migration/ack sync failures propagate instead of returning false success.
- **Honest backend guarantees:** the no-visibility guarantee for create-only Root writes is scoped to backends with atomic no-replace publication (`require`, or `auto` with a loaded binding); the JavaScript fallback's behavior is documented and regression-pinned.

### Secret files and permissions

- Preserve existing secret-directory permissions instead of repairing them; retain lossless directory identities through private locks and native writes, initialize new directories through guarded descriptor authority, honor full directory mode bits, and fail closed for unpinnable parents, including non-root macOS directories created under `umask(0o777)`.
- Finalize explicit file modes after content writes across pinned writers, verify all `0o7777` POSIX bits for secret publication, and use exact identities before native Windows mode changes and failed-write cleanup; JavaScript fallback cleanup preserves unverified replacements.
- Complete short synchronous regular-file appends and preserve explicitly requested special mode bits in both append helpers, retaining permission tightening before any data is written.
- Verify atomic secret writes through the writer's retained descriptor so restrictive POSIX modes such as `0o000` and `0o200` succeed without a readonly reopen or widened permissions.
- Retry and fully revalidate raced secret-parent creation so concurrent writes to distinct leaves succeed without leaking `EEXIST` or reporting a false `secret-exists` collision.
- Scope the sibling-temp no-visibility guarantee for create-only Root writes (`create`, `createJson`, `write({ overwrite: false })`) to backends with atomic no-replace publication: the native binding stages privately and renames without clobbering, while the pure-JavaScript fallback claims the final name exclusively before content is written. Regression tests now pin both behaviors.
- Normalize every exclusive-copy target to mode `0o600` through its owned descriptor, including under restrictive umasks and native macOS clone staging.

### Locks and durable queues

- Retry Windows Root-backed sidecar exclusive-create denials within the existing eight-retry and caller budgets, using per-call provenance while preserving callback errors and rejecting replayed failure evidence.
- Release asynchronously acquired Root-backed sidecar locks on natural event-loop shutdown through their retained ownership receipts, preserving changed sidecars and avoiding cleanup retry loops.
- Keep async Root-backed lock normalization read-only, rejecting deleted or replaced admitted parents without recreating them while preserving explicit in-root sidecars for external target keys.
- Reject serialized sidecar lock payloads above 1 MiB of UTF-8 bytes, including ownership overhead, with `too-large` before async or sync acquisition so admitted locks remain verifiable and releasable.
- Honor explicit async file-lock retry counts independently of infinite deadlines, matching sync locks while preserving unlimited retries when the count is omitted.
- Propagate durable queue enqueue parent-sync failures and keep published-file identity checks after synchronization, sharing the guarded writer with migrations while retaining retry state.
- Propagate durable queue batch claim and migration failures instead of returning empty or partial success, and strictly sync migration publication in both loaders while preserving retry state.
- Resync durable queue acknowledgement retries after final marker unlink before reporting completion or a newer-generation mismatch.

### Paths, stores, and moves

- Enforce portable FileStore keys consistently across methods: async reads, `exists`, and `remove` now reject parent-segment and backslash aliases with `invalid-path` for existing roots, matching sync and write methods while preserving missing-root error precedence and Root's confined existing-object compatibility.
- Prevent no-reader FIFOs from stalling POSIX `Root.openWritable()` and async/sync regular-file append admission, preserving regular-file write semantics and existing-target cleanup fencing.
- Accept canonical in-root absolute paths in `Root.readAbsolute()` and `Root.reader()` when the Root was configured through a directory symlink or Windows junction.
- Reject dangling symlink leaves and ancestors under strict absolute-write and missing local-root resolution instead of treating unresolved aliases as safe missing paths.
- Move dangling symlink sources through staged and cross-device fallback without dereferencing their absent referents, while retaining same-entry, descendant, and source-substitution guards.
- Retire every copied source name after cross-device moves with allowed in-tree hardlink aliases, while preserving `ESTALE` fences for unverified external mutations.
- End `Root.walk()` immediately after its single truncation marker, including when a nested depth or entry budget is reached.
- Bound callback staging components to 255 NFC/NFD bytes so filesystem-valid long destination names work without changing final names or short callback paths.

### Archives

- Separate archive staging permissions from final publication modes so zero/write-only files and restrictive directories extract correctly; finalize explicit and implicit directory modes through retained, verified authority and reject unsafe mode application instead of silently skipping it.
- Preserve pre-existing and substituted destination files when an archive merge fails, leaving guarded copy cleanup to the operation that owns publication.
- Decode absent TAR modes and supported signed GNU binary permission bits in native manifests, matching JavaScript defaults without changing the native ABI.
- Close a selected archive input if private staging allocation fails, preventing `readArchiveEntry()` setup errors from retaining file descriptors until garbage collection.
- Avoid opening the TAR metadata stream until preflight setup succeeds, and always destroy it after pipeline completion, preventing descriptor leaks on setup failures. Thanks @SebTardif.

### Docs, packaging, and validation

- Add the narrow `@openclaw/fs-safe/secure-temp-root` package subpath so consumers can import `resolveSecureTempRoot()` and its options type without loading the temp workspace implementation.
- Exercise secret-directory admission from isolated npm/pnpm consumer installs, retain real-identity and native-load proof, and honor explicit package-proof output paths.
- Correct lower-level archive helper signatures in the reference docs and guard them against drifting from the public declarations.
- Keep slow physical-package fixture setup outside the process-exit test deadline, drain fixture work before teardown, and give each adversarial corpus payload its own test lifetime while retaining Windows boundary assertions.
- Bound workflow-dispatch test subprocesses and terminate their process groups before fixture cleanup, so stuck shell descendants fail validation instead of hanging the suite.
- Assign cross-platform sidecar contention proof liveness to its whole-worker watchdog instead of false-failing healthy unfair acquisition; production lock timeout behavior is unchanged.
- Refresh the Node type definitions, align development and CI on pnpm 11.25.0, and update the pinned Pages deployment action to v5.0.1 for polling backoff and jitter. Thanks @dependabot.

## 0.7.2 - 2026-09-01

- Add `movePathWithCopyFallback({ assertBeforeRename })` to synchronously recheck caller-owned authorization immediately before direct or staged rename, preserving refusal errors and rejecting asynchronous callbacks without publishing the move.

## 0.7.1 - 2026-09-01

### Highlights

- **Make lock handoffs reliable:** recover from disappearing ownership records within retry budgets, preserve callback errors, and safely retry failed synchronous release cleanup.
- **Reject corrupt native ZIP reads:** verify decoded entry length against the declared size before returning bytes, while retaining byte caps and CRC checks.
- **Preserve long destination filenames:** use independent private staging names for Root writes and copies, ZIP extraction, and synchronous JSON writes instead of lengthening the destination basename.

### File locks

- Recover Root-backed asynchronous handoffs from unlinked opened records with exact descriptor identity and unlink evidence, including Windows resolver `EPERM`/`EBADF` failures. Recheck canonical ancestors and charge discarded observations to retry/deadline budgets without granting release or reclaim authority. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Retry Root lock contention when a holder changes between pre-open inspection and opening the file. Discard only the verified stale observation, recheck canonical ancestors, and require fresh exclusive creation; generic reads, creator admission, and release/reclaim authority remain unchanged.
- Verify reopened Root-created sidecars against the creator's exact serialized bytes and ownership token before admission. Reject replacements and unlinked descriptors, and retain the original creator receipt for failed-acquisition cleanup. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Align Windows synchronous lock-parent canonicalization with Root, including short-name expansion, and bound lock-file create/open denials and missing or changed snapshot retries. Preserve the original `EPERM` when a retry budget is exhausted. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Determine synchronous lock staleness from the captured payload timestamp or snapshot mtime, avoiding false stale decisions after unlink or replacement. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Retain failed synchronous release cleanup for safe retries without double-decrementing references, re-closing a consumed or reused descriptor, or deleting a replacement sidecar. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Propagate payload, JSON serialization, and parsing failures unchanged without retrying the failing callback. Scope Root failure evidence to each observation so historical errors cannot trigger retries in later, nested, or concurrent acquisitions. ([#190](https://github.com/openclaw/fs-safe/pull/190))

### File writes and archives

- Keep private staging names independent of destination basenames across guarded Root writes and copies, native Windows writes, ZIP extraction, and `writeJsonSync()`. Preserve public producer filenames, custom `tempPrefix`, and literal JSON parent-path and drive-relative semantics. ([#191](https://github.com/openclaw/fs-safe/pull/191))
- Avoid opening an existing target merely to inherit its mode during create-only Root writes, while preserving boundary, alias, hardlink, and type checks. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Reject native `readArchiveEntry()` ZIP payloads whose decoded length differs from the declared uncompressed size with `ArchiveFormatError("archive-header-invalid")`, matching JavaScript behavior while preserving `maxBytes` and CRC checks. ([#189](https://github.com/openclaw/fs-safe/pull/189))

### Docs and validation

- Clarify that invalid UTF-8 or nonzero bytes after NUL terminators in fixed TAR name, linkname, and USTAR prefix fields reject with `ArchiveSecurityError("entry-path")`; this documents existing behavior. ([#189](https://github.com/openclaw/fs-safe/pull/189))
- Add cross-process contention and release-retry proofs, plus focused lock-admission and ZIP-integrity coverage in JavaScript-fallback and required-native CI paths. Refresh the release checklist for eight-package trusted publishing.

## 0.7.0 - 2026-08-31

### Highlights

- **Safer reads and writes:** extend exact identity checks and retained-descriptor publication to reject substituted inputs and detect publication mismatches, including rounded-equal Windows file IDs.
- **Opt into bounded temp cleanup:** `cleanupSafety: "require-bounded"` prevents recursive traversal of substituted workspace trees, while the compatible default remains available without native support. See the [cleanup guarantees and POSIX limits](https://fs-safe.io/temp.html#private-temp-workspaces).
- **Harden untrusted archive handling:** reject hidden path aliases, ambiguous TAR metadata, corrupt gzip streams, and excessive decoded data before publication; align filtering and entry reads across JavaScript and native backends.
- **Preserve queued work and durability:** generation-bound claims protect newer same-ID entries from acknowledgement or quarantine, and queue transitions and synchronous store writes sync their filesystem changes.
- **Make lock handoffs and timeouts reliable:** recover from ownership records unlinked during contention, surface release failures, and finish in-flight archive publication or rollback before returning a timeout.

### Compatibility and upgrade notes

- **Claim queued entries before processing.** Call `loadJsonDurableQueueEntry()` or the batch loader before acknowledgement, rather than pairing a direct read with `ackJsonDurableQueueEntry()`. A pending entry without a processing claim now rejects; missing entries remain idempotent no-ops. Queue and failed directories must share a filesystem with hardlink support for quarantine. See the [queue recovery contract](https://fs-safe.io/store.html).
- **Handle the new cleanup result.** `TempWorkspaceCleanupResult` adds `"indeterminate"` for cleanup whose safe completion cannot be established. Exhaustive result handlers must accept it; do not treat it as successful removal or blindly delete retained artifacts.
- **Archive filters receive canonical pre-strip paths.** `entryFilter` now sees normalized separators, dot components, and effective metadata names rather than alternate spellings of the same entry. Update filters that match raw aliases; invalid `onFiltered` values reject before extraction rather than enabling skipping.
- **Validate limits and handle surfaced errors.** Root, FileStore, secure/secret/regular reads, durable queues, and external output require `maxBytes` to be a non-negative safe integer or positive `Infinity`; zero is enforced and `undefined` retains configured defaults. Lock retry/deadline numbers are validated. Handle propagated release, failed-acquire cleanup, and durability failures; exhaustive archive-limit handlers must accept `archive-decoded-size-exceeds-limit`.

### File safety and temp cleanup

- Verify regular-file reads, root-file adapters, archive staging, `Root.copyIn()` sources, and durable JSON queue reads with lossless bigint identities. Reject replacements whose IDs round to the same JavaScript number and unresolved Windows identities before reading bytes; public numeric `Stats` receipts remain unchanged.
- Verify async and sync regular-file append targets against exact pre-open, descriptor, and current-path identities, rejecting rounded-equal replacements and persistent unknown Windows identities before chmod or append.
- Retain async and sync atomic replacement descriptors across `beforeRename`, retries, copy fallback, and publication. Reject substituted, non-regular, or hardlinked stages and preserve unowned cleanup paths. `replaceFileAtomic()` and its sync variant add `renameIdentity: "verify-content-with-lock"` for rename-unstable FUSE mounts: an explicit weaker identity contract for cooperating writers, not protection against same-authority actors ignoring the lock.
- Pin callback-produced sibling temps through mode application, optional fsync, rename, and publication checks. Preserve unverified paths and producer modes, retain disabled sync defaults and best-effort file/directory chmod, and admit read-only descriptors unless `writeSiblingTempFile` requests file sync.
- Apply `writeJsonSync()` best-effort file-mode tightening only through a reopened, single-link regular descriptor matching the staged bigint identity, so a swap cannot chmod an unrelated file.
- Add native handle-relative temp workspace removal with collision-safe quarantine, enumerated-child identity checks, mount-crossing rejection, and symlink/reparse leaf removal without target traversal. Windows deletes exact opened handles; POSIX retains a documented final name-based race bounded to one substituted leaf or empty directory entry, never recursive traversal of a substituted nonempty tree.
- Require usable Linux `openat2` with `RESOLVE_NO_XDEV` at runtime for bounded cleanup. Compatible mode falls back when unavailable; `cleanupSafety: "require-bounded"` rejects before creating a child.
- Open attacker-raceable secure, secret, archive, queue, publication, fallback, and lock-file read paths nonblocking on POSIX, so a FIFO substitution cannot stall admission, deadlines, or cleanup verification.

### Archive extraction and reads

- Prevent archive path aliases from bypassing excluded subtrees: pass canonical pre-strip paths to `entryFilter` across JavaScript/native ZIP, TAR, gzip, zstd, and bzip2, while retaining raw-path validation, stripping, collision checks, and filter rejection policy.
- Reject ambiguous TAR EOF framing, unsafe numeric sizes, and bodies on raw directory/link entries before parsing. Enforce an absolute decoded-byte ceiling through physical EOF, including metadata and zero padding, before extraction publication or entry-read success; report `archive-decoded-size-exceeds-limit` on overflow.
- Bound retained TAR manifests with a shared budget capped at 64 MiB, independent of compressed input size. Validate checksums, strict fixed-field UTF-8, NFC/NFD component lengths, GNU effective trailing separators, and linkname/type consistency before metadata processing or caller policy.
- Validate GNU long-name/link bodies on both backends before parsing: reject malformed UTF-8/NUL structure, repeated or dangling metadata, mixed PAX/GNU chains, and unsafe effective names, while preserving original bytes and valid L+K pairs.
- Apply ordered path, count, strip, depth, collision, and filter policy even to TAR records parsers would ignore (`V`, `A`, `I`, `M`, and unknown typeflags). Safely omit accepted unsupported records, validate raw names hidden by metadata or NUL terminators, and align native device/FIFO filtering and GNUDumpDir handling with JavaScript.
- Stop starting archive destination mutations at the timeout boundary and wait for any already-running destination mutation and rollback before rejecting. Non-mutating work retains prompt deadlines; publication cannot continue after the timeout is reported.
- Match `readArchiveEntry()` to extraction's validated canonical pre-strip paths and effective metadata names across all supported formats/backends. Preserve directory, link, collision, integrity, and byte-limit checks; read `maxBytes` remains a requested-entry budget, separate from archive-wide decoding and metadata limits.
- Charge TAR `maxEntryBytes` and `maxExtractedBytes` only to entries accepted after strip/filter policy, not skipped or fully stripped members. Raw framing, logical entry counts, metadata, and absolute decoded-byte limits still apply to the whole archive.
- Accept highly compressible gzip TARs within fs-safe's explicit limits consistently across backends by disabling node-tar's extra 1000x ratio threshold only after complete decoded-byte admission. Archive, decoded, entry, output, and deadline limits remain enforced.
- Preserve large finite TAR limits such as `Number.MAX_VALUE` in native `auto`/`require` modes through shared internal metadata/decoded-byte and u32 entry-count clamping before backend selection; retain high-level payload budgets and reject malformed direct native limits.
- Update native gzip/DEFLATE decoding to flate2 1.1.10 and miniz_oxide 0.9.1, including upstream incomplete-stream fixes. Truncated bodies, missing trailers, and checksum failures reject before extraction publishes files or an entry read returns bytes.

### Durable queues, stores, and locks

- Claim durable queue generations under a fail-closed cross-process lock using no-replace hardlinks and recoverable source retirement. Acknowledgement and quarantine preserve newer same-ID replacements, and quarantine collisions preserve existing failed-entry evidence.
- Fsync affected directories for queue creation, claims, acknowledgement, quarantine, marker cleanup, and retirement; propagate durability failures. Synchronous file-store writes now fsync temps before rename and parent directories after publication.
- Retry Root-backed sidecar acquisition when the owner unlinks its record after the waiter opens it, but only after the same Root capability proves absence. Replacements remain fail-closed; generic `Root.open()` behavior is unchanged.
- Propagate asynchronous sidecar release and failed-acquire deletion failures, preserve paired errors, and retain failed release state for a safe retry through the same handle or manager drain.
- Clamp synchronous lock backoff to the remaining finite deadline instead of overshooting the timeout or blocking forever.

## 0.6.0 - 2026-08-29

### Highlights

- Install only the matching native platform package; deployments using native mode `require` or native-only features must keep optional dependencies enabled. See the [0.6 migration guide](https://fs-safe.io/migrating-to-0.6.html).
- Strengthen root, secure, secret, and pathname-hash identity checks with lossless bigint comparisons and fail-closed handling of unknown Windows identities.
- Add native-required Linux/macOS `stageFileInDirectory()` with retained-directory cleanup, private staging, identity-checked publication, and async disposal.
- Validate physical ZIP metadata and names before decoder normalization or collapse, align bounded TAR/PAX and stripped-path handling, and reject ZIP symlinks disguised as directories.

### Security and Correctness

- Validate physical ZIP local/central and Unicode name metadata before decoding, rejecting traversal, hidden duplicates, and conflicting interpretations consistently in extraction and bounded reads.

- Verify pathname SHA-256 hashing with lossless pre-open, descriptor, and current-path identities; fail closed on unknown Windows identities after one bounded retry without reopening the file.
- Preserve underlying command diagnostics (command, timing, timeout flag, exit code/signal, and sanitized stderr) and cause on Windows ACL `permission-unverified` errors without changing verification semantics.
- Verify secure and secret read identities with lossless bigint stats, reject replaced paths and retargeted aliases, and fail closed on unknown Windows identities after one bounded re-inspection; preserve the secure reader's numeric `Stats` receipt and permission options without letting them bypass identity checks.
- Apply the same exact identity checks to guarded root reads, rejecting parent-directory replacements even when distinct Windows file IDs round to the same number; retain numeric read receipts and keep Windows write reopens anchored to the writer's exact retained identity.
- Verify `Root.write()` and `create()` through retained descriptors and exact bigint identities for restrictive final modes, retaining guarded Windows path opens when pathname identity is unavailable; preserve explicit mode zero in `copyIn()`.
- Preserve filesystem failures from `ensureDirectoryWithinRoot()` and `pathScope().ensureDir()` in an optional operational `FsSafeError` diagnostic with the original cause and bounded, escaped display text, instead of misreporting them as containment violations; keep nonthrowing string results and directory safety checks.
- Accept bounded local PAX paths, sizes, and descriptive metadata, including inert binary macOS provenance xattrs, consistently in JavaScript and native TAR extraction/reads; reject ambiguous records, extension chains, and sparse semantics while retaining byte/count limits and guarded staging. Return TAR read traversal failures through the public promise instead of escaping the parser callback.
- Add native-required Linux/macOS `stageFileInDirectory()` under `advanced` with retained-directory abort cleanup, private `0600` staging until publication is identity-checked, exact identity checks, explicit publication/cleanup receipts, and async disposal; share that ownership with POSIX native streaming writes so parent moves no longer strand their unpublished temps.
- Share native writer admission and direct-child cleanup mechanisms; preserve combined POSIX coordinator operation/disposal failures with `SuppressedError` while keeping staged preparation/cleanup receipts and Windows close policy unchanged.
- Fail closed when synchronous sidecar compromise checks hit I/O errors and invoke `onCompromised` once instead of throwing from the interval. Thanks @SebTardif.
- Reject ZIP symlink-mode entries with a trailing slash or DOS directory bit before creating output, aligning JavaScript extraction with native link policy while preserving explicit filtering. Thanks @Yigtwxx.
- Make the validated stripped path authoritative during JavaScript TAR extraction, fixing `ENOENT` and native path disagreement for dot or empty components, including local PAX paths, while preserving pre-strip filter inputs. Thanks @Yigtwxx.
- Apply process-wide retry, timeout, and stale-policy defaults to synchronous file locks while preserving per-call overrides and caller-approved guarded recovery. Thanks @Yigtwxx.

### Docs and Tooling

- Publish native bindings as platform-filtered optional packages and load only the matching package, avoiding installation of binaries for six unrelated targets; verify root-only npm/pnpm resolution and document omitted-optionals limits and native-only recovery guidance. Thanks @RomneyDa.
- Raise the Crabbox AWS root volume to 400 GiB to meet the runner image's snapshot minimum and avoid allocation failures before checks run.
- Restore six missing documentation navigation entries, remove the dangling page, correct the lock-config link, and reject missing, nonexistent, or duplicate registrations before replacing site output. Thanks @Yigtwxx.
- Fix the standalone native smoke script to use the numeric descriptor returned by `openBeneath()` for identity checks and cleanup.
- Accept npm 11 array and npm 12 package-name-keyed pack results while validating the intended package and its file metadata.

### Dependencies and maintenance

- Refresh the Node and Rust dependency graphs, align development and CI on pnpm 11.24.0, and update the CodeQL, npm, and cargo-zigbuild pins while preserving the two-day dependency cooldown.

## 0.5.6 - 2026-08-14

### Security and Correctness

- Treat asynchronous sidecar compromise-check I/O failures as a lost lock and invoke `onCompromised` once, instead of leaking an unhandled rejection from the interval.
- Preserve replaced temporary paths during Windows cleanup when libuv reports a zero device or inode or a file index exceeds JavaScript's safe integer range, treating unknown or rounded identity as fail-closed instead of authorizing deletion.

### Docs and Tooling

- Set up Node before pnpm when hydrating Crabbox runners so minimal images without a preinstalled npm can prepare the workspace.
## 0.5.5 - 2026-08-12

### Security and Correctness

- Prevent nondeterministic Windows read failures with `path-mismatch` when path-based stat reports zero file identity through libuv's FindFirstFile fallback under antivirus or indexer contention; zero Windows inodes are now treated as unknown identity like zero device serials.

## 0.5.4 - 2026-08-10

**Highlight:** two security fixes in the publication path. If you run fs-safe on
Windows, the identity fix is the one that matters — rounded file indexes could
previously let a replaced path pass as the original.

### Security and Correctness

- Compare exact bigint filesystem identities during exclusive publication and rollback cleanup. Windows rounds file indexes, so a replaced source or target path could previously masquerade as the original — and, worse, authorize deletion of an attacker's replacement. Identity comparisons are now exact.
- Open pinned and standalone regular-file reads nonblocking on POSIX before validating the descriptor type, so a raced FIFO or device cannot stall the worker. The same read-open flags are now shared by root reads, hashing, and move-copy fallbacks, so the guarantee holds on every path rather than just the one that was fixed.

### Dependencies and maintenance

- Refresh the napi toolchain (napi 3.12.1, napi-derive 3.6.3, napi-build 2.4.1) and the Rust and Node development dependency graph.

## 0.5.3 - 2026-08-08

### Security and Correctness

- Reject NTFS alternate data stream archive entry names on Windows before extraction, keep JavaScript and native TAR/ZIP policy aligned, and fix one-code-unit native rename and hardlink metadata buffers.
- Reject synchronous secret reads when the path is retargeted after the preview check, matching the asynchronous reader's `path-mismatch` contract instead of returning bytes from the replacement file.
- Preserve dangling symlinks when trash moves cross filesystems instead of failing while following their missing targets.
- Reject non-canonical FileStore keys and malformed archive names before filesystem access, keep JavaScript/native TAR and ZIP rejection semantics aligned (including full-width base-256 sizes and empty ZIP files), and add deterministic property-based regression coverage for path aliasing, parser boundaries, collisions, truncation, and extraction limits.

### Compatibility

- Report filesystem I/O failures from secret, `FileStore`, and temp-workspace twin readers as the new operational `read-failed` code with the original error in `cause`, replacing synchronous secret `invalid-path`, asynchronous secret and synchronous store `path-mismatch`, and raw Node errors; consumers matching the old wrapper or `EIO`-style top-level code should match `read-failed` and inspect `cause.code` instead.
- Preserve semantic path and validation codes in synchronous `FileStore` and temp-workspace reads: missing temp leaves now report `not-found`, stable directories report `not-file`, and hardlinks and symlinks report `hardlink` and `symlink`, replacing `path-mismatch` and fabricated raw `ENOENT` respectively to match their asynchronous twins; consumers treating either old result as absence or identity drift should match the specific path-state code instead.
- Report an existing non-directory ancestor as `not-file` from both `assertNoSymlinkParents()` variants, replacing asynchronous success and the synchronous helper's platform-dependent success or raw `ENOTDIR` under default `allowMissing`; callers relying on that acceptance should ensure every existing prefix component is a directory or handle `not-file`.

### Docs and Tooling

- Measure coverage once per operating system and merge the platform reports before enforcing thresholds, so coverage reflects existing cross-platform execution rather than implying new test coverage.
- Refresh Vite and its Rolldown toolchain, and declare the native build CLI's Emscripten runtime peer explicitly.

## 0.5.2 - 2026-08-02

### Security and Correctness

- Reject negative, malformed, and oversized base-256 TAR sizes using the full encoded field, preventing high-order size bytes from bypassing archive metadata metering.
- Preserve unrelated files when the create-only JavaScript `Root.write()` fallback loses a parent-directory race during post-write verification, limiting failure cleanup to the inode created by the operation.
- Report the documented `not-file` code when a writable Root open reaches a non-regular descriptor on Windows, matching the existing POSIX `EISDIR` mapping.
- Serialize same-target `Root.write()` and `Root.copyIn()` calls before inspecting the existing destination, so ordinary overlapping writers do not race the mode-preservation open against another writer's atomic replacement.
- Serialize same-target directory replacements, confine their randomized backup names to the target parent, retain identity-bound exit cleanup after transient atomic/output/move staging cleanup failures, and refuse to publish EXDEV move copies when descriptor-bound mode application fails.
- Stream native pinned-write inputs only after create-only collision checks, avoiding backend-dependent eager buffering, and preserve explicit zero file modes instead of replacing them with `0o600`.
- Verify synchronous file-store publication by inode after rename and avoid pathname-based post-publication mode changes, so a raced symlink or hardlink swap fails closed without changing an unrelated target's permissions.
- Track live JSON-store mutation ownership separately from inherited async context, so continuations scheduled by an update can mutate the store after that update finishes while genuinely nested mutations remain rejected.
- Serialize private secret and file-store publications by canonical destination, preventing ordinary overlapping writers from tripping the fallback's post-rename identity fence while retaining atomic last-writer-wins replacement.
- Preserve replacement sidecars when asynchronous lock setup fails, remove an identity-matching `Root`-backed sidecar when its post-create open fails, and clean up synchronous sidecars on normal process exit.
- Pin each `Root` handle to the canonical root directory identity so root-path replacement cannot expose outside metadata through `stat()`, `exists()`, `list()`, or `walk()`, and preserve a swapped-in writable leaf when failed-open cleanup no longer owns its inode.
- Fail closed on invalid walk and absolute-path policies, keep standalone walk budgets bounded at runtime, reject final symlinks from absolute writable paths, and observe aborts that arrive during directory listing.
- Canonicalize configured local-root symlinks, recognize case-insensitive `file:` URL schemes (including unsafe device targets) using the requested platform's path semantics, validate every configured root, confine secure-temp fallback prefixes to one segment, preserve replaced temp-file directories during cleanup, return absolute install paths, and avoid splitting Unicode surrogate pairs while truncating filenames.
- Reject archive output names that collide after case or Unicode normalization, keeping extraction deterministic across JavaScript/native backends and case-insensitive filesystems.
- Escape control characters in archive-entry and root-path diagnostics, and reject NUL inputs plus embedded Windows drive-relative segments in the direct sync and async root resolvers before Node can echo raw attacker-controlled paths from a syscall error or resolve the two variants differently.
- Shell-quote POSIX permission-remediation paths, and report a secret file that grows past the synchronous read limit as `too-large` just like the asynchronous reader.
- Fence pathname SHA-256 hashing against pre-open identity replacement, propagate bounded-stream source failures while tearing down file streams on early consumer close, and report synchronous regular-file disappearance races as `path-mismatch` consistently with the async reader.
- Pin synchronous file-store roots across every parent-walk segment, so private and non-private writes reject a store root replaced during directory creation, and route deny-mutation ancestor canonicalization through the shared root resolver on Windows and POSIX.
- Keep the POSIX parent-directory no-follow identity check active for synchronous atomic-replacement adapters that omit `fchmodSync`, preventing the documented default adapter path from writing through a symlinked parent.
- Synchronize the actual destination after descriptor-bound mode application when atomic rename uses copy fallback, and include both bytes and mode in bounded fallback restoration.
- Continue accepting legacy atomic-replacement adapter literals that expose pathname `chmod` or `chmodSync` methods while keeping those methods unused.
- Reject archive NUL names, drive-relative path segments, duplicate output names (including collisions introduced by `stripComponents`), and ZIP CRC or declared-size mismatches before publishing output. Explicit zero archive limits now remain zero, and stripped TAR entries count toward `maxEntries`, keeping the native and JavaScript policies aligned.

- Reject non-file sidecars without spinning, and read contended async and synchronous sidecar locks through bounded, no-follow, identity-checked descriptors; keep valid `createdAt` timestamps authoritative under filesystem clock skew; fail closed when fallback Windows ACL inspection returns no verifiable access entries; preserve synchronous stale-reclaim guards owned by another acquirer; and share one process-exit cleanup listener across file-lock manager domains.

- Route `Root.copyIn()` and overwrite-capable `Root.write()` commits through a new descriptor-relative native replace rename, closing a parent-symlink swap that could create a missing destination directory outside the root before the JavaScript fallback detected the escape. Native `auto` and `require` mode now protect both create-only and replacing pinned writes; the explicitly best-effort JavaScript fallback remains available in `off` mode or when `auto` cannot load a binding.
- Report `not-found` rather than `invalid-path` or raw `ENOENT` when pinned `Root.write()` and `Root.copyIn()` calls cannot find their parent with `mkdir: false`, preserving the documented operational error category.
- Reject stable intermediate symlinks in default `Root` reads and the sync/async root-file helpers, while preserving `device-path` precedence for lexically explicit unsafe namespaces such as `/dev/fd`; compare the pre-open path identity with the opened descriptor so an in-root parent swap reports `path-mismatch`, open reads nonblocking where supported so a raced FIFO cannot pin a worker, and report followed symlink loops with the documented `symlink` code.
- Reject surrounding whitespace in every async and sync `FileStore` key instead of silently trimming one caller-supplied key onto another.
- Keep Windows-ignored trailing spaces and dots from disguising reserved device basenames such as `CON .` in `sanitizeUntrustedFileName()` output.
- Report overlong `Root` inputs as `invalid-path` instead of misclassifying the filesystem's `ENAMETOOLONG` failure as `outside-workspace`.

- Apply `movePathWithCopyFallback()` file and POSIX directory modes through staging descriptors before publication, so a replaceable staging pathname cannot redirect `chmod` to an unrelated symlink target. Windows no longer uses a pathname fallback for directory modes because Node cannot portably open a directory descriptor there and does not enforce POSIX modes.

- Reject drive-relative segments such as `C:secret.txt` and `a/C:b` in portable relative-path parsing and every `FileStore` key, and reject leading drive-relative spellings on `Root` destinations and `resolve()` with `invalid-path`. Existing-object Root operations, including reads, inspection, removal, and the source of `move()`, continue to accept legal POSIX filenames such as `c:notes.txt`; thanks @Yigtwxx for the fix.

- Apply atomic-replacement parent-directory modes through verified no-follow descriptors on POSIX, so a directory-entry swap cannot redirect `chmod` through a symlink to an unrelated directory. Windows keeps its explicit `mkdir(mode)`-only behavior because Node does not enforce POSIX directory modes there.
- Retry a contended file-lock acquisition when Windows denies access to a lock file whose directory entry is still being torn down, including when the native binding performs the exclusive create. Both the exclusive create and the holder's snapshot read reported that transient `EPERM` as a hard failure, so concurrent `acquireFileLock()` calls failed intermittently on Windows even though the very next attempt would have succeeded. Retries stay bounded, so a genuine permission denial still surfaces as `EPERM` rather than a lock timeout; thanks @Yigtwxx for the fix.
- Apply `replaceFileAtomic()` and `replaceFileAtomicSync()` modes through pinned temp-file descriptors before rename, and through pinned copy-fallback descriptors, so a post-rename symlink swap cannot redirect `chmod` to an unrelated file while exact modes remain independent of umask; thanks @yetval for reporting this (#86).
- Bound fallback Windows owner and ACL command execution to 30 seconds per process, tolerating loaded runners while still terminating wedged commands, and report owner-query failures as unverified instead of returning a partial permission classification; thanks @Yigtwxx for the diagnosis.
- Verify published npm bytes directly when registry integrity metadata conflicts, and cryptographically verify the registry signature plus Sigstore provenance against the package digest and the trusted fs-safe release workflow (#81).
- Report the documented `remove()` failure codes instead of collapsing every failure to `path-alias`. A missing target now throws `not-found`, a non-empty directory throws `not-empty`, and any other filesystem failure throws `not-removable`, while directory identity drift keeps reporting `path-mismatch`; thanks @Yigtwxx for the fix.

### Compatibility

- Report access-denied failures from native Windows operations as `EPERM` rather than `EACCES`, matching Node/libuv and the JavaScript fallback. Consumers that matched the previous native-only `EACCES` code should accept `EPERM` as well when supporting older package versions.
- Add an optional `fchmodSync` operation to the injectable synchronous atomic-replacement filesystem type. Async adapters need no new member because their required `open()` returns a mode-capable `FileHandle`; custom sync adapters that pass `mode`, `dirMode`, or `preserveExistingMode` now fail before mutation when `fchmodSync` is absent, while plain `node:fs` injection and adapters that request none of those options remain compatible.
- Classify `not-found`, `not-empty` and `not-removable` as operational rather than policy errors, so `FsSafeError.category` no longer reports routine filesystem outcomes as safety-policy rejections.

### Features

- Suffix Windows reserved basenames with `_` in `sanitizeUntrustedFileName()` while preserving case and extensions on every platform, including dollar names and superscript COM/LPT variants; thanks @SebTardif (#67).

### Docs and Tooling

- Refresh the native package build CLI to `@napi-rs/cli` 3.8.2.
- Give parallel native archive tests collision-free temporary paths so one fixture cannot remove another test's file on coarse-resolution clocks.
- Include the README banner in the npm tarball and require it during pack checks so the published README does not reference a missing package asset; sanitize pnpm-only npm configuration from package-smoke subprocesses so the documented release check stays warning-free on newer npm versions.
- Audit every public export and documented default against generated declarations and real filesystem behavior, add executable documentation-contract coverage, and correct stale examples and security guarantees across root writes, local roots, shared types, paths, temp roots, archives, errors, and filename portability.

- Create GitHub Releases as drafts before npm publication, then attach immutable verification proof and promote them only after the published package passes the shared registry verifier, avoiding stranded releases during registry propagation incidents (#81).

## 0.5.1 - 2026-08-01

### Security and Correctness

- Stop trimming surrounding whitespace when normalizing Windows paths for comparison, so a space-padded root no longer compares equal to its unpadded sibling and `isPathInside` keeps reporting outside paths as outside.
- Apply `denyMutations` prefixes to the directory they name on Windows. A prefix with trailing whitespace previously compared equal to its unpadded sibling, so the named directory stayed writable while the sibling was blocked; the two `preserves trailing whitespace` deny-mutation cases now run on Windows instead of being skipped.
- Replace backtracking-prone path-segment, temp-name, and Windows device-path sanitizers with linear scans to keep attacker-controlled inputs from causing excessive CPU use.

### Docs and Tooling

- Refresh the npm and Rust build toolchains, including the `zip` 8.6 native archive reader and the latest pinned CodeQL v4 action.
- Publish only the validated release tarball after asserting its byte identity against the release manifest, and tolerate npm registry propagation with bounded exponential backoff.

## 0.5.0 - 2026-07-27

### Highlights

- Add policy-driven archive entry filtering and mode handling, bounded single-entry archive reads, root-bounded async walking, synchronous sidecar locks, async secret reads, create-only secret writes, and exclusive file publication.
- Add public streaming `sha256File(path | FileHandle)` hashing with optional async native acceleration, plus policy-free Windows owner/DACL facts with owner and current-process-user SIDs and per-ACE masks and inheritance flags.
- Add native fd-relative ZIP and TAR extraction/read support with gzip, zstd, and bzip2 streaming; TypeScript evaluates the shared entry policy before Rust creates any output, and zstd/bzip2 report a typed native-required error when no binding is available.
- Bound PAX, GNU long-name/link, and sparse metadata with one `maxMetaEntryBytes` policy shared by node-tar and the native fixed-header metering reader, including typed failures for oversized or malformed metadata.
- Add `Root.walk()` subtree pruning and partial directory-error reporting for bounded best-effort consumers, plus a shared `maxEntryPathComponents` archive limit that rejects implicit-directory depth attacks before either extraction path creates output.
- Bundle all seven prebuilt native binaries inside the single `@openclaw/fs-safe` package for fd-relative opens, guarded directory creation and hardlinks, atomic no-replace rename, and file identity checks. This deliberately increases the package size in exchange for deterministic installs with no optional platform packages, downloads, postinstall step, or consumer Rust build; unsupported platforms silently use the guarded JavaScript fallback in `auto` mode.

### Security and Correctness

- **Security — `resolveRootPath()` / `resolveRootPathSync()`:** Published releases through 0.4.7 validated a lexically normalized path spelling, so a caller-supplied path traversing an in-root symlink could pass validation while resolving outside the root. Version 0.5 fixes this with component-wise alias resolution. `root()` handles were **not** affected: their operations have contained this case since `5ddca80`, so exposure is limited to direct users of these two exported helpers.
- Prefer macOS 15.4's `O_RESOLVE_BENEATH` for native opens, retain the guarded component walk on older kernels, and apply an `F_GETPATH` post-open escape detector to both routes without claiming rename-race atomicity.
- Report open containment explicitly: native `openBeneath()` returns `{ fd, containment }` with `kernel-atomic` on Linux and `best-effort` on macOS/Windows, while JavaScript root open/read/writable results report `best-effort`.
- Serialize async `jsonStore` writes and read-modify-write updates in-process by canonical store path before taking the cross-process sidecar lock, preventing overlapping `write`, `update`, and `updateOr` calls from silently losing updates; reject nested same-path mutations with typed `store-reentrant-update` errors. Thanks @yetval for reporting this.
- Create `append`, `openWritable`, and fallback `copyIn` parents through guarded per-component walks and continue I/O through the resolved in-root parent, preventing symlink-swap races from creating directories outside the root while preserving valid in-root symlink parents. Thanks @yetval for reporting this.
- Add pinned-destination hardlink rejection and bounded original-content restoration to `replaceFileAtomic()` and its sync variant, including typed `restored` / `restore-failed` receipts for torn copy-fallback writes.
- Add sibling staging to `writeExternalFileWithinRoot()`: external producers can write a randomized file in the target directory for fsynced same-filesystem atomic replacement, while private workspace staging remains the cross-device-tolerant default; staged and final basenames share portable C0/C1 and Windows-invalid-character sanitization on every host.
- Enforce `movePathWithCopyFallback({ sourceHardlinks: "reject" })` with a streaming, entry-capped recursive preflight before mutation, closing a shipped 0.4.x gap where the common same-filesystem rename bypassed the policy; approved trees commit through a fresh staged copy with open-time and post-copy link-count fences so a scan/rename race cannot publish a hardlinked inode.
- Abort and tear down JavaScript TAR extraction immediately when entry policy, path validation, link rejection, or a budget fails, preventing node-tar from leaving a paused parser after rejected fleet-restore entries; both native and JavaScript paths now return the same typed archive-policy errors.
- Attach a post-creation failure receipt to `publishFileExclusive()` errors with the failing phase, whether this call created the target, its observed identity, and whether cleanup removed, preserved, or could not classify the target.
- Add `publishFileExclusive({ onSyncFailure: "rollback" | "preserve" })`: rollback remains the default, while preserve keeps a complete target after directory-sync failure and reports the failed sync outcome in the typed provenance receipt.
- Close the pinned publication source on parent-pinning failure so every acquired descriptor is released on every exit path.
- Remove the native loader's PATH-resolved `ldd` execution. Linux libc detection now uses the Node process report, conventional musl library filenames, and the Node executable's ELF interpreter without spawning a process at import time; an inconclusive probe conservatively attempts glibc and falls back normally in `auto` mode.
- Default archive extraction to `entryModes: "clamp"`, normalizing directories to `0o755` and files to `0o644` or `0o755` while always stripping setuid, setgid, and sticky bits; use `"preserve"` to retain safe archived rwx bits.
- Prefer native create-only commits, sidecar acquisition, hardlink publication, and the explicit `rename-noreplace` publication strategy when the platform binding is available, while retaining guarded JavaScript fallbacks for `auto` and `off` modes.
- Accelerate exclusive publication fallbacks with macOS `fclonefileat`, Linux `FICLONE` and `copy_file_range`, then the unchanged JavaScript byte loop; all paths retain exclusive creation, identity fencing, mode normalization, and SHA-256 verification through an async native hash task when available.
- Add direct Windows owner/DACL inspection and protected private-directory creation for the current owner, LocalSystem, and Administrators, while retaining the existing .NET/`icacls` behavior when native mode is unavailable, forced off, or encounters an unsupported descriptor form.
- Keep the public private-directory creator Windows-only and native-only so POSIX pathname races or inherited ACLs cannot weaken its privacy guarantee.
- Build Linux native opens on `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)`, macOS opens on an in-root `O_NOFOLLOW` component walk, and Windows opens on handle-relative `NtCreateFile` with reparse-point rejection.

### Compatibility

- Remove the unsound process-scoped `allowReentrant` async file-lock option and replace it with owner-scoped `reentrantOwner` for async and sync locks: only matching, explicitly defined logical owners reuse a canonical in-process lock, releases are reference-counted and idempotent, and different or absent owners contend normally. Callers that passed the boolean must either remove it or migrate intentional nesting to a per-operation owner key; `jsonStore` remains ownerless and rejects nested same-file mutations immediately.
- Remove the persistent Python helper and its `pythonPath` configuration. Replace `configureFsSafePython`, `FS_SAFE_PYTHON_MODE`, and the OpenClaw Python aliases with `configureFsSafeNative` and `FS_SAFE_NATIVE_MODE`; 0.5 warns once and maps the former `auto`, `require`, and `off` policies solely as an upgrade bridge for shipped 0.4 consumers.
- Add `publishFileExclusive({ strategy: "rename-noreplace" })`; this strategy requires the native helper, atomically moves the source, and never replaces an existing destination.

### Docs and Tooling

- Add an ordered 0.4-to-0.5 migration checklist and reconcile every new archive, native, publication, walk, lock, secret, permission, and temp-workspace contract with realistic examples and cross-links.
- Convert the repository to a pnpm workspace, test the Rust crate on Linux, macOS, and Windows, and publish all platform bindings, the native loader, and the root package through one protected-tag release pipeline with npm provenance.
- Replace unused napi-rs Android, FreeBSD, OpenHarmony, WASI, and unsupported-architecture loader branches with a checked-in loader for the seven packages actually published, and make publication benchmarks report the exercised clone/copy/JavaScript tier plus filesystem environment.

## 0.4.7 - 2026-07-24

### Features

- Add `@openclaw/fs-safe/durability` with identity-pinned directory handles,
  explicit strict sync outcomes, synchronous and best-effort variants, and
  durable nested-directory creation through every new parent edge.

### Security and Correctness

- Reject final symlinks, FIFOs, non-directories, canonical-path drift, and
  descriptor/path identity replacement before or after directory sync.
- Propagate POSIX directory synchronization failures while classifying known
  unsupported Windows directory flushing only after revalidating the target;
  directory-open access failures remain strict.
- Route sibling-temp, root, and pinned-write best-effort parent synchronization
  through the shared guarded primitive instead of maintaining divergent implementations.

### Docs and Tooling

- Document directory receipts, pin lifecycle, platform outcomes, custom
  creation callbacks, and the boundary between filesystem durability and
  application commit protocols.

## 0.4.6 - 2026-07-24

### Highlights

- Reject foreign-owned or unverifiable Windows files in secure reads while
  preserving supported trusted local owners and exact extended drive paths.

### Security and Correctness

- Report Windows owner SIDs and whether the owner is the current user,
  LocalSystem, or built-in Administrators so credential-bearing executable
  checks can reject foreign-owned paths even when their visible DACL is
  read-only. Secure reads enforce the result and remote filesystems fail
  closed.
- Read Windows owner and DACL data through the underlying .NET security
  descriptor APIs so verification does not depend on PowerShell security-module
  autoloading.
- Invoke `icacls.exe` with its supported path-only inspection syntax and use
  the live Windows user/domain environment for named ACE classification, so
  ACL verification works on supported Windows hosts instead of failing on the
  invalid `/sid` argument.
- Normalize trailing Windows install-root separators with a bounded linear
  scan so library-provided environment maps cannot trigger regex backtracking.

### Docs and Tooling

- Add the public repository governance baseline, pinned CodeQL analysis,
  package tarball/import validation, and protected tag-driven npm trusted
  publishing with provenance and changelog-derived GitHub releases.
- Let tag-driven publishing continue from an expected registry miss into npm
  trusted publishing instead of exiting before the publish attempt.
- Publish the generated tarball through an explicit relative path so npm treats
  it as a local artifact instead of GitHub repository shorthand.

## 0.4.5 - 2026-07-20

### Highlights

- Preserve sidecar-lock ownership across filesystem identity drift without weakening legacy stale-lock checks.

### Security and Correctness

- Give new sidecar locks an internal random ownership token outside the parsed JSON payload so release remains ownership-checked when virtual filesystems report different descriptor and pathname identities, while legacy locks retain the stricter identity-plus-content check.

## 0.4.4 - 2026-07-18

### Security and Correctness

- Restore opt-in stale sidecar recovery with an exclusive reclaim guard that serializes snapshot verification and unlink, preserving dead-owner recovery without allowing a competing reclaimer to delete a fresh replacement lock.

## 0.4.3 - 2026-07-18

### Compatibility

- Restore the pre-0.4.2 `readRegularFile` and `readRegularFileSync` overflow error message while retaining allocation-bounded reads and the structured `too-large` error on the new low-level bounded-read primitives.

## 0.4.2 - 2026-07-18

### Features

- Add bounded async/sync reads for already-open file descriptors and handles, plus optional byte caps for standalone JSON readers.

### Security and Correctness

- Make capped root, regular-file, secure-file, secret-file, structured JSON, and synchronous store reads incremental so a file that grows after validation cannot trigger an unbounded allocation.
- Disable `remove-if-unchanged` stale sidecar deletion because a pathname identity check followed by unlink can delete a replacement lock; retain the deprecated recovery inputs for compatibility while all stale locks fail closed.

### Compatibility

- Treat `EPERM` from pinned-write file and directory `fsync` calls as best effort for filesystems that permit the write but reject explicit synchronization.

## 0.4.1 - 2026-07-01

### Security and Correctness

- Update the optional TAR extractor to reject NUL-terminated PAX values, invalid negative entry sizes, and explosive decompression payloads.

### Compatibility

- Add explicit `renameIdentity: "verify-content-with-lock"` writes for rclone-style FUSE mounts whose inode identity changes across rename, while keeping strict identity verification as the default and failing closed on stale cooperative locks. (#32, #33; thanks @jlautman)

## 0.4.0 - 2026-06-17

### Features

- Report unreadable walk roots and subdirectories through `failedDirs` from `walkDirectory()` and `walkDirectorySync()`, preserving readable results while letting destructive reconciliation distinguish incomplete scans from empty directories. (#29; thanks @amknight)

### Compatibility

- Require Node.js 22 or newer for the npm package and docs, matching the maintained CI matrix.

### Security and Correctness

- Fall back to the existing copy/remove move path when Windows denies directory renames with `EPERM`, preserving skill updates while watched files are locked. (#27; thanks @liuxingwei0601)
- Sync `root.append` file handles before close and sync the parent directory when append creates a file, preserving append-mode concurrency while improving durability. (#21; thanks @KumarAnandSingh)
- Reject known unsafe device and process-fd read paths before opening files, including `/dev/zero`, `/dev/random`, `/dev/fd/*`, `/proc/*/fd/*`, and Windows reserved device names.

## 0.3.0 - 2026-05-21

### Features

- Add opt-in `denyMutations` policies with exact `paths` and subtree `prefixes` so callers can protect application-sensitive files from root write, copy, move, remove, mkdir, and writable-open operations. (#20; thanks @amknight)

### Security and Correctness

- Retry async JSON reads (`readJson`, `readJsonIfExists`, `tryReadJson`) up to five attempts with 50ms exponential backoff when the file is rotated mid-read by an atomic rename, and tag the underlying race as `FsSafeError("path-mismatch")` so callers can distinguish transient swaps from corruption. (#19; thanks @yetval)

## 0.2.7 - 2026-05-20

### Security and Correctness

- Restore best-effort Node write fallbacks when the Python helper is disabled or unavailable, preserving the `mode: "off"` contract while documenting the weaker POSIX same-UID race resistance compared with fd-relative helper commits.
- Harden DeepSec-reported archive staging and input pinning, secret and queue hardlink rejection, absolute output file validation, sidecar lock read failures, ClawSweeper dispatch trust checks, and scoped path defaults.

## 0.2.6 - 2026-05-17

### Security and Correctness

- Harden DeepSec-reported temp path handling, private secret writes, pinned helper commits, fallback mkdir writes, and dot-prefixed root relative paths against symlink, race, and relative-path edge cases.

## 0.2.5 - 2026-05-16

### Security and Correctness

- Reject Windows drive-letter paths on POSIX secure-file reads, missing path fallbacks under symlinked parents, swapped archive destination roots, broad domain ACL principals, and hardlinked sync store reads.
- Preserve top-level JSON `null` values in JSON stores and reject non-document JSON values such as top-level `undefined` before replacing files.
- Fix timeout error factories, root-relative path resolution at filesystem roots, dot-prefixed child names in root path helpers, durable queue directory modes, and pinned helper stale-worker events.

### Build

- Clean `dist` before package builds and make prepack fail deterministically when dependencies are missing instead of resolving new toolchain versions at publish time.

### Tests

- Added Clawpatch regression coverage for secure reads, path fallback validation, sync stores, archive destination races, Windows ACL classification, JSON writes/stores, durable queue modes, root create no-clobber behavior, and pinned helper worker replacement.

## 0.2.4 - 2026-05-14

### Features

- Add opt-in `remove-if-unchanged` stale lock recovery so callers can centralize compare-and-remove mechanics while keeping application-owned stale-owner policy.

## 0.2.3 - 2026-05-14

### Fixes

- Classify broad Windows ACL identities such as Anonymous Logon, Guests, Interactive, Local, and Network as world-equivalent so writable paths are not downgraded to group-writable findings.

## 0.2.2 - 2026-05-11

### Fixes

- Fall back to Node path guards for root stat and list operations on Windows, where the pinned Python helper is intentionally unsupported.

## 0.2.1 - 2026-05-08

### Fixes

- Align POSIX and Windows handling for literal `..`-prefixed write targets, preserve whitespace in direct home-relative path inputs, and run the check suite on Windows CI. (#14; thanks @sjf)
- Keep source prepack builds isolated from parent monorepo ambient type packages such as Bun typings. (#13; thanks @Kaspre)
- Let secret-file reads follow symlink paths through the pinned real target unless callers opt into `rejectSymlink: true`.

## 0.2.0 - 2026-05-07

### Features

- Add `writeExternalFileWithinRoot()` for libraries that require an output path while preserving caller-provided destination names. (#7; thanks @jesse-merhi)
- Add root JSON helpers and durable JSON queue helpers for file-backed work queues with pending, delivered, failed, and acknowledgement flows.
- Add `ensureAbsoluteDirectory()` for creating trusted absolute directory paths one segment at a time while rejecting symlink and non-directory components. (#12; thanks @jesse-merhi)
- Add a `durable: false` option to async atomic text and JSON writes so callers can preserve replace semantics while skipping temp-file and parent-directory fsync. (#9; thanks @sallyom)
- Add process-wide sidecar lock defaults while keeping JSON store locking opt-in per resource.

### Security and Correctness

- Harden Root fallback mutators, archive merges, private store reads/writes, durable queue ids, JSON fallback writes, sibling temp writes, temp filename sanitization, and trash moves against symlink-swap and path traversal edge cases.
- Centralize safe path segment validation, directory identity guards, guarded mkdir, and guarded mutation wrappers so filesystem helpers reuse the same race-resistant checks.
- Route archive ZIP staging, temp workspace sync reads, secret-file commits, and atomic move/replace fallbacks through shared pinned-read or guarded-write primitives without applying private-directory modes to public paths.
- Close guarded fallback write handles without following path names if post-write directory verification fails, avoiding descriptor leaks and unsafe cleanup in symlink-swap races.
- Harden temp filename prefixes, local-root reads, private store imports, durable queue reads, and regular-file byte caps against Deepsec-reported path traversal, symlink, and oversized-read races.
- Harden sidecar lock cleanup and stale-lock handling so stale third-party locks fail closed instead of being deleted by path.

### Compatibility

- Make cross-device move fallbacks reject source changes during staged copies and clean up only the source entries copied into the staged destination, preserving concurrent source additions or replacements instead of recursively deleting them.
- Preserve directory modes during cross-device directory moves.
- Preserve empty-directory pruning and broken-symlink trash moves across guarded fallback paths.
- Preserve sync file-store read policy errors for directory and hardlink validation failures.
- Preserve existing temp workspace leaf filename behavior for names such as `.env` and filenames containing spaces.
- Preserve public parent-directory modes when writing JSON, moving files across devices, and extracting archives.
- Make `prepack` portable on Windows and add the missing pnpm workspace `packages` field so package preparation succeeds consistently.

### Tests

- Added regression coverage for the filesystem race and traversal findings fixed in this release.
- Added Deepsec regression coverage for unsafe temp tokens, dangling symlinks, default read caps, private `copyIn()` races, symlinked queue entries, oversized queue entries, and fresh sidecar lock preservation.
- Added regression coverage for external-output traversal rejection, guarded cleanup, sidecar lock stale handling, move fallback cleanup, durable queue validation, sync read policy failures, and absolute-directory validation.
- Added a static filesystem-boundary primitive check that blocks reintroducing known raw copy/read/guard patterns.

### Docs and Tooling

- Added docs for external output writers, durable JSON queue helpers, sidecar lock defaults, boundary guardrails, and absolute-directory creation.
- Enable ClawSweeper dispatch for pull-request review automation.

## 0.1.2 - 2026-05-06

### Fixes

- Reject `fileStore()` and `fileStoreSync()` writes through symlinked parent directories so store commits cannot escape the configured root.

### Tests

- Increased filesystem edge coverage around secure temp fallback handling, sibling-temp cleanup, local-root resolution, file locks, and file identity checks.
- Prevented POSIX test runs from leaving Windows-style secure-temp fallback paths in the repository root.

### Docs

- Added missing docs pages for `@openclaw/fs-safe/config`, `@openclaw/fs-safe/store`, `@openclaw/fs-safe/advanced`, and `@openclaw/fs-safe/test-hooks`.
- Corrected path-helper docs for the synchronous `isPathInsideWithRealpath` and `safeRealpathSync` behavior.
- Included the Markdown docs in the npm package so README links resolve after install.

## 0.1.1 - 2026-05-06

### Fixes

- Preserve the caller's destination path spelling during staged archive merges so symlink-rebind checks catch alias races on macOS.
- Reject archive writes that gain a hardlink alias during post-write verification and clean up the destination file.

## 0.1.0 - 2026-05-06

### Features

- Added `root()` capability-style filesystem handles for root-bounded reads, writes, appends, moves, copies, directory listing, stat, mkdir, remove, JSON, streams, and existence checks.
- Added traversal, symlink, hardlink, alias, and post-open/post-write identity checks for untrusted relative paths.
- Added process-global Python helper configuration for stronger POSIX fd-relative mutation paths, with `auto`, `off`, and `require` modes.
- Added atomic file and directory replacement helpers with mode control, fsync options, retry handling, and copy-fallback behavior.
- Added JSON helpers, `fileStore()`, `jsonStore()`, private store mode, and file-backed temporary workspaces.
- Added secure absolute file reads, secret-file helpers, permissions inspection, Windows ACL helpers, and local-root readers.
- Added archive extraction and preflight helpers for ZIP/TAR with optional `jszip` and `tar` dependencies, size/count/path/link limits, and staged destination writes.
- Added file locks, async locks, bounded directory walking, install-path sanitizers, filename sanitization, regular-file helpers, trash moves, and advanced composition helpers.
- Added OpenClaw bypass-parity coverage, API coverage, a benchmark workflow, docs site generation, security docs, and coverage CI.
