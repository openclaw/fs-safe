# Changelog

## Unreleased

- **Imports:** add focused `/file-identity`, `/file-io`, `/regular-file`, and `/root-path` entry points so filesystem composition can reuse the existing guarded helpers without loading the full Root implementation.

- **Locked byte ranges:** `sha256File()`, `sha256FileSync()`, `sameFileContentsSync()`, `copyFileDescriptorSync()`, and `copyRootFileSync()` accept `zeroRanges`, byte ranges treated as zeros without being read. Callers can hash, compare, and copy SQLite databases larger than 1 GiB on Windows while another connection holds SQLite's mandatory lock bytes.

## 0.28.2 - 2026-11-22

**Highlights:** Windows bindings no longer need a separate Visual C++ Redistributable, long temporary-file paths work reliably, and archive decoding handles chunked bzip2 input plus gzip/deflate fixes.

### Fixes

- **Windows native loading:** remove the separate Visual C++ Redistributable prerequisite for x64 and ARM64 bindings while retaining the OS-serviced UCRT. Thanks @paulcam206. ([#1094](https://github.com/openclaw/fs-safe/pull/1094))

- **Windows temp files:** create temporary directories on long paths without exposing extended-length namespace aliases to callers; preserve identity and cleanup checks. Thanks @xuanda0201. ([#1091](https://github.com/openclaw/fs-safe/pull/1091))

- **Archive decoding:** preserve bzip2 decoder progress for valid streams with long coding tables split across input chunks, and update native gzip/deflate decoding fixes. ([#1103](https://github.com/openclaw/fs-safe/pull/1103))

## 0.28.1 - 2026-11-13

**Highlights:** Fixes for Root lock contention, stale-lock diagnostics, guest temporary names, and opt-in DrvFS writes.

### Fixes

- **Guest filesystem:** generate temporary names with OS randomness without importing Python hashing or TLS modules; preserve name entropy and exclusive-create behavior. ([#1085](https://github.com/openclaw/fs-safe/pull/1085))

- **File locks:** restore custom stale-policy diagnostics for empty or malformed owner records while keeping unverifiable owners ineligible for automatic removal. ([#1079](https://github.com/openclaw/fs-safe/pull/1079))

- **Root file locks:** restore POSIX acquisition I/O errors as `FsSafeError` with the existing `invalid-path` code and original cause; retain raw-lock and Windows fallback error identity. Retry verified concurrent publication handoffs to avoid spurious `path-mismatch` and `outside-workspace` failures. ([#1081](https://github.com/openclaw/fs-safe/pull/1081), [#1087](https://github.com/openclaw/fs-safe/pull/1087))

- **DrvFS opt-in writes:** skip recovery preparation on known non-9p filesystems, caching only negative observations so later writes add no filesystem calls while recovery keeps full mount and identity verification. ([#1080](https://github.com/openclaw/fs-safe/pull/1080))

## 0.28.0 - 2026-11-07

**Highlights:** Crash-safe lock publication and working writes on Docker Desktop Windows bind mounts through the new opt-in `allowDrvfsRenameRecovery`. ([#1066](https://github.com/openclaw/fs-safe/pull/1066), [#1076](https://github.com/openclaw/fs-safe/pull/1076), [#1074](https://github.com/openclaw/fs-safe/pull/1074))

### Features

- **Atomic writes:** add the explicit, off-by-default `allowDrvfsRenameRecovery` option for verified DrvFS mounts, with documented residual inode-reuse risk. ([#1074](https://github.com/openclaw/fs-safe/pull/1074))

- **Temp workspaces:** add opt-in `trustedWritableAncestors` for externally isolated deployments. Exact named ancestors may be group/world writable while ownership, private-directory permissions, and path-integrity checks remain enforced; defaults stay strict. Using the exception emits a path-free `FS_SAFE_TRUSTED_WRITABLE_ANCESTOR` warning once per process. Thanks @Kimiyu-186. ([#1073](https://github.com/openclaw/fs-safe/pull/1073))

### Fixes

- **DrvFS publication:** recover files hidden until the last descriptor closes on verified Windows-drive mounts, retaining exact identity, ownership, mode, size, link-count, parent, and available content checks. Thanks @om49967588 for the report and @lswang9 for the probes. ([#1074](https://github.com/openclaw/fs-safe/pull/1074))

- **File locks:** stage and sync complete owner records before exclusive publication; retain mutually exclusive create-and-write on mounts without no-replace rename or hardlinks, where a crash can leave an empty or partial lock requiring offline recovery. Existing unverifiable locks remain untouched. Thanks @chrislro. ([#1066](https://github.com/openclaw/fs-safe/pull/1066), [#1076](https://github.com/openclaw/fs-safe/pull/1076))

- **Windows batch reads:** retain the native descriptor's matching closer through admission and return it as optional `close()` on successful reads; use it to avoid Worker descriptor warnings. Thanks @shenghu7358 for the OpenClaw report. ([#1071](https://github.com/openclaw/fs-safe/pull/1071))

## 0.27.2 - 2026-11-05

**Highlights:** POSIX reads stay responsive on slow storage; Windows public-path inspection keeps TrustedInstaller trust narrow, and release verification dependencies include denial-of-service fixes.

### Fixes

- **POSIX reads:** keep root acquisition, root-file opens, and Root read admission off the JavaScript thread while preserving pinned-descriptor identity and final root/path checks; retain Windows and custom synchronous adapter behavior.
- **Windows permissions:** trust exact TrustedInstaller ownership and serviced read-only sources for public inspection while rejecting servicing write grants on user-owned or user-writable profiles and retaining strict private-file checks. Thanks @paulcam206.
- **Temporary filenames:** preserve safe Unicode names, including CJK text and accents, while retaining path/control filtering, Windows device protection, and portable byte limits. Thanks @beeven.
- **Release verification:** patch denial-of-service issues in the provenance verifier's dependency chain.

## 0.27.1 - 2026-10-31

**Highlights:** Native POSIX staged file creation, atomic publication, small-buffer writes, path-prefix canonicalization, and awaited root-path traversal no longer block the JavaScript thread, so slow storage cannot stall the event loop. ([#1052](https://github.com/openclaw/fs-safe/pull/1052), [#1053](https://github.com/openclaw/fs-safe/pull/1053), [#1054](https://github.com/openclaw/fs-safe/pull/1054))

### Features

- **Path prefixes:** add `resolvePathPrefix` for asynchronous component traversal and make `resolveAbsolutePathForRead` use asynchronous Node canonicalization, keeping filesystem waits off the JavaScript thread while preserving physical symlink and missing-suffix semantics. ([#1053](https://github.com/openclaw/fs-safe/pull/1053))

### Fixes

- **Root traversal:** keep awaited POSIX root-path metadata and canonicalization off the JavaScript thread so slow component lookups do not stall the event loop; preserve synchronous APIs, identity fences, and Windows publication behavior. ([#1054](https://github.com/openclaw/fs-safe/pull/1054))
- **Async writes:** keep native POSIX staged creation, atomic publication, and small-buffer writes off the JavaScript thread so slow storage does not stall the event loop. ([#1052](https://github.com/openclaw/fs-safe/pull/1052))

## 0.27.0 - 2026-10-30

**Highlights:** Use `dirMode: "preserve"` for shared workspaces to keep verified existing write parents unchanged while creating new directories at `0700`. ([#1050](https://github.com/openclaw/fs-safe/pull/1050))

### Features

- **Directory modes:** add `dirMode: "preserve"` to keep verified existing write parents unchanged while creating new directories at `0700`. Thanks @rbartoli for the OpenClaw PR motivated by [openclaw/openclaw#184867](https://github.com/openclaw/openclaw/issues/184867). ([#1050](https://github.com/openclaw/fs-safe/pull/1050))

## 0.26.15 - 2026-10-30

**Highlights:** Awaited authority checks for borrowed-handle overwrites, so callers can move currentness checks off the main thread. ([#1049](https://github.com/openclaw/fs-safe/pull/1049))

### Features

- **In-place writes:** add `overwriteFileHandleWithAuthority` for awaited authority preparation followed by a synchronous final assertion before writing a borrowed handle. Existing `overwriteFileHandle` behavior is unchanged. ([#1049](https://github.com/openclaw/fs-safe/pull/1049))

### Performance

- **Watch hint admission:** reduce repeated admission of unrelated canonical parents within a batch while retaining per-hint identity checks and conservative alias reconciliation. Thanks @wr-web for reporting [openclaw#186752](https://github.com/openclaw/openclaw/issues/186752) and @DonnieFi for [#1046](https://github.com/openclaw/fs-safe/pull/1046).

## 0.26.14 - 2026-10-30

**Highlights:** Clearer errors for denied Root traversal and reliable async file-lock contention. ([#1044](https://github.com/openclaw/fs-safe/pull/1044), [#1045](https://github.com/openclaw/fs-safe/pull/1045))

### Fixes

- **Root errors:** report denied path traversal as operational `permission-denied`, preserving the original errno and path instead of implying a path-alias violation. Thanks @LiuwqGit for [openclaw/openclaw#184115](https://github.com/openclaw/openclaw/issues/184115). ([#1044](https://github.com/openclaw/fs-safe/pull/1044))
- **File lock contention:** use the admitted record's timestamp for async stale detection so ordinary owner release and re-creation do not trigger spurious `path-mismatch` failures. ([#1045](https://github.com/openclaw/fs-safe/pull/1045))

### Security

- **Archive dependencies:** update zstd to 0.14.3, zstd-safe to 8.2.0, and zstd-sys to 2.1.2 for native and WASM archive builds, retaining the custom WASM allocator and allocation-failure checks. ([#1039](https://github.com/openclaw/fs-safe/pull/1039))

## 0.26.13 - 2026-10-24

**Highlights:** Reliable file publication on NFS mounts.

### Fixes

- **Guest creation on NFS:** close the synced payload before publication so deferred unlink cannot report `ESTALE` after creating the destination. Thanks @bsteiner98 for [openclaw/fs-safe#1024](https://github.com/openclaw/fs-safe/issues/1024). ([#1033](https://github.com/openclaw/fs-safe/pull/1033))
- **NFS publication:** retain the destination descriptor while settling staged creates, copies, and no-replace file publication, preventing open temporary names from causing false post-publication failures while retaining exact identity and link-count checks. Thanks @bsteiner98 for [openclaw/fs-safe#1024](https://github.com/openclaw/fs-safe/issues/1024). ([#1034](https://github.com/openclaw/fs-safe/pull/1034))

## 0.26.12 - 2026-10-23

**Highlights:** Keep durable native writes responsive by synchronizing staged files and publication directories asynchronously.

### Fixes

- **Async native writes:** synchronize staged files and publication directories asynchronously, retaining durability and descriptor ownership without blocking the JavaScript thread.

## 0.26.11 - 2026-10-23

### Highlights

- **macOS root paths:** accept differently cased root paths on case-insensitive filesystems and return consistent on-disk spelling. ([#1022](https://github.com/openclaw/fs-safe/pull/1022), [#1025](https://github.com/openclaw/fs-safe/pull/1025))
- **Windows volume-root ACLs:** expose verified local volume-root facts so consumers can distinguish ineffective DELETE-self grants from replaceable directory permissions. ([#1023](https://github.com/openclaw/fs-safe/pull/1023))

### Fixes

- **macOS guarded reads:** accept differently cased root paths on case-insensitive filesystems by binding native root spelling to the same directory identity. Thanks @0xtc23 for [openclaw#181107](https://github.com/openclaw/openclaw/issues/181107). ([#1022](https://github.com/openclaw/fs-safe/pull/1022))
- **macOS realpath spelling:** `safeRealpathSync` returns the on-disk spelling on POSIX, so differently cased paths resolve to the same identity that guarded opens use instead of looking like root escapes. Thanks @obviyus. ([#1025](https://github.com/openclaw/fs-safe/pull/1025))
- **Windows ACL facts:** identify OS-verified local volume roots so consumers can distinguish ineffective DELETE-self grants from replaceable directory permissions, while retaining all ACL rights and fail-closed unknown/remote results. Thanks @WG-Mojo for [openclaw#180892](https://github.com/openclaw/openclaw/issues/180892). ([#1023](https://github.com/openclaw/fs-safe/pull/1023))

## 0.26.10 - 2026-10-21

### Fixes

- **Read-only filesystems:** include the failed path in native file, stage, and sidecar creation `EROFS` diagnostics, with operation and flags for beneath opens, while preserving existing error codes. Thanks @eliasbogordos for [openclaw#178322](https://github.com/openclaw/openclaw/issues/178322).

### Packaging

- **macOS addons:** Developer ID sign both architectures with the OpenClaw Foundation identity and hardened runtime, and require Apple notarization before packaging.

## 0.26.9 - 2026-10-20

**Highlights:** Recover macOS watchers when FSEvents streams are exhausted, improve watcher error handling, and verify published package completeness.

### Fixes

- **macOS watch:** fall back to guarded polling when FSEvents cannot create or start a stream during initial `auto` admission, including system-wide stream exhaustion. Explicit event and required-native modes still fail. Thanks @LGx0. ([#1005](https://github.com/openclaw/fs-safe/issues/1005))

- **Watch errors:** consistently report `path-mismatch` if a Root disappears during identity revalidation, without adopting a replacement directory.

- **Windows watch:** avoid spurious overflow notifications when an unrelated directory disappears during path validation, while retaining failures for persistent access errors and selected-path changes.

### Packaging

- **macOS addons:** ad-hoc sign both native architectures and verify their signatures before packaging, so x64 and ARM64 addons consistently pass strict code-signature checks.

- **Package completeness:** verify literal relative runtime imports, module-relative worker URLs, and assets against the actual npm tarball during package checks and release collection, catching files omitted by the package allowlist. Thanks @vincentkoc. ([#1008](https://github.com/openclaw/fs-safe/pull/1008))

## 0.26.8 - 2026-10-18

### Highlights

- **Watcher reconciliation:** measured Linux polling on a 20,313-directory tree uses about 10× less idle CPU and 29× fewer filesystem syscalls, with worst event-loop stall reduced from 151 ms to about 6 ms. ([#1002](https://github.com/openclaw/fs-safe/pull/1002))

### Performance

- **Watcher reconciliation:** reuse unchanged guarded watcher listings between full safety-net reconciliations, with guarded filesystem work in a shared Node worker thread, cheap per-entry metadata checks and full rescans on uncertainty. Ticks reconcile incrementally; full guarded reconciliation runs every five minutes by default, configurable with `fullReconcileIntervalMs`. Thanks @martinderm for [openclaw#174341](https://github.com/openclaw/openclaw/issues/174341). ([#1002](https://github.com/openclaw/fs-safe/pull/1002))

## 0.26.7 - 2026-10-17

### Highlights

- **Windows idle watch CPU:** share native identity and physical-path queries while retaining directory checks. ([#1000](https://github.com/openclaw/fs-safe/pull/1000))
- **Root containment:** preserve kernel parent semantics through nested and dangling symlink chains, and reject redirected sibling-output parents. ([#993](https://github.com/openclaw/fs-safe/pull/993))
- **Legacy native policy migration:** removed Python-mode settings now fail with an actionable migration error when no explicit native policy is selected. ([#995](https://github.com/openclaw/fs-safe/pull/995))

### Fixes

- **Windows watch scan CPU:** share native identity and physical-path queries while retaining every listed entry's directory checks. Thanks @martinderm for reporting the idle Gateway CPU regression in [openclaw#174341](https://github.com/openclaw/openclaw/issues/174341). ([#1000](https://github.com/openclaw/fs-safe/pull/1000))
- **ZIP integrity:** update the native ZIP decoder while preserving format-error and byte-limit classifications for entries that exceed their declared size. ([#997](https://github.com/openclaw/fs-safe/pull/997))
- **Release dry runs:** keep generated unsigned package artifacts outside source-provenance checks so the final package smoke test can complete without signing or publishing. ([#996](https://github.com/openclaw/fs-safe/pull/996))
- **Root containment:** resolve nested and dangling symlink chains with kernel parent semantics, and reject redirected sibling-output parents before invoking external writers. Thanks @yetval for [#987](https://github.com/openclaw/fs-safe/issues/987) and [#986](https://github.com/openclaw/fs-safe/issues/986). ([#993](https://github.com/openclaw/fs-safe/pull/993))
- **Watch invalidations:** refresh the admitted parent after transient create/delete activity so consumer caches cannot retain a file absent from both watcher scans. ([#993](https://github.com/openclaw/fs-safe/pull/993))

### Compatibility

- **Legacy native policy migration:** reject removed `FS_SAFE_PYTHON_MODE` and `OPENCLAW_FS_SAFE_PYTHON_MODE` settings with an actionable migration error when no explicit native policy is selected, instead of silently changing `require` or `off` to `auto`. Set the corresponding native-mode variable to the same value before upgrading. ([#995](https://github.com/openclaw/fs-safe/pull/995))

## 0.26.6 - 2026-10-15

### Fixes

- **Btrfs file cloning:** explicit `clone: "auto"` and `"always"` copies match NOCOW on their new empty destination so different source and destination-directory policies do not force a full byte copy. Sources and unrelated destination flags are preserved; automatic fallback recreates the destination with its ordinary inherited policy.

## 0.26.5 - 2026-10-14

### Highlights

- **Android/Termux and WSL compatibility:** create temporary workspaces under Android system-owned ancestors and complete short nonblocking reads on WSL/9p filesystems. ([#982](https://github.com/openclaw/fs-safe/pull/982), [#983](https://github.com/openclaw/fs-safe/pull/983))
- **Windows synchronous read batches:** add `createRootFileOpenBatchSync()` to reuse native root handles while retaining per-file safety checks. ([#984](https://github.com/openclaw/fs-safe/pull/984))

### Features

- **Windows synchronous read batches:** reuse native root handles with `createRootFileOpenBatchSync()` while retaining fresh file identity, reparse, hardlink, byte-limit, and confinement checks. ([#984](https://github.com/openclaw/fs-safe/pull/984))

### Fixes

- **WSL/9p reads:** finish short nonblocking reads instead of truncating uncapped files, atomic copy fallbacks, or content verification. Thanks @Hawk5150 for [openclaw/openclaw#145589](https://github.com/openclaw/openclaw/issues/145589). ([#983](https://github.com/openclaw/fs-safe/pull/983))
- **Android/Termux temp workspaces:** admit system-owned ancestors and Android-private writable groups while preserving private roots and full ancestry checks. Thanks @kukirin-ui for [openclaw/openclaw#171406](https://github.com/openclaw/openclaw/issues/171406). ([#982](https://github.com/openclaw/fs-safe/pull/982))

## 0.26.4 - 2026-10-13

### Fixes

- **Windows AppContainers:** private files and directories now work inside a Windows AppContainer: the creating container can reopen them and other containers stay denied. Requires the native addon; folder-mounted volumes fail closed. Behavior outside a container is unchanged. Thanks @jonathanlindsay. Reported in [openclaw/openclaw#160287](https://github.com/openclaw/openclaw/issues/160287); limits are in the [permissions guide](docs/permissions.md#advanced-windows-acl-helpers). ([#980](https://github.com/openclaw/fs-safe/pull/980))

### Docs and Tooling

- **Windows durability costs:** explain what non-durable writes cost and save on Windows. ([#973](https://github.com/openclaw/fs-safe/pull/973))

## 0.26.3 - 2026-10-13

### Highlights

- **Native health and signed Windows binaries:** inspect runtime native support with `getFsSafeNativeStatus()`; Windows addons and the security helper now carry timestamped OpenClaw Foundation signatures. ([#965](https://github.com/openclaw/fs-safe/pull/965), [#960](https://github.com/openclaw/fs-safe/pull/960))
- **Linux copy compatibility:** recover from refused reflink I/O, including ZFS block cloning, through a guarded byte copy. ([#972](https://github.com/openclaw/fs-safe/pull/972))
- **Less native filesystem overhead:** retain directory parents, reuse writable-file admission, batch Root verification, and avoid unrelated macOS watch wakeups. ([#971](https://github.com/openclaw/fs-safe/pull/971), [#959](https://github.com/openclaw/fs-safe/pull/959), [#966](https://github.com/openclaw/fs-safe/pull/966), [#955](https://github.com/openclaw/fs-safe/pull/955), [#968](https://github.com/openclaw/fs-safe/pull/968))

### Features

- **Native runtime health:** add async `getFsSafeNativeStatus()` with optional probing, path-free load reasons, and actionable guidance, exported from the root and `config` entry points. ([#965](https://github.com/openclaw/fs-safe/pull/965))
- **Signed Windows binaries:** Authenticode-sign both Windows native addons and the security helper with timestamped OpenClaw Foundation signatures, and verify the signed bytes before publication. ([#960](https://github.com/openclaw/fs-safe/pull/960))

### Fixes

- **High-bit filesystem identities:** preserve Node's signed bigint stat identities across native directory checks, allowing guarded writes and build locks on filesystems with high-bit inode numbers. ([#979](https://github.com/openclaw/fs-safe/pull/979))
- **Linux reflink fallback:** fall back to a guarded byte copy when FICLONE refuses I/O with `EIO` or `EAGAIN`, including ZFS block cloning; real copy and cleanup errors remain fatal. Reported in [openclaw/openclaw#169071](https://github.com/openclaw/openclaw/issues/169071). ([#972](https://github.com/openclaw/fs-safe/pull/972))
- **Native fallback warnings:** explain why native support is unavailable, name the expected package version, and give cause-specific recovery guidance for Windows security and private-creation fallbacks. ([#961](https://github.com/openclaw/fs-safe/pull/961))

### Performance

- **Native directory creation:** retain parent handles during recursive mkdir, reducing the measured case from 160 to 5 promises and 381 to 74 Linux syscalls; nested mkdir also reuses existing parents. ([#971](https://github.com/openclaw/fs-safe/pull/971), [#959](https://github.com/openclaw/fs-safe/pull/959))
- **Native writable-file creation:** reuse parent admission, reducing measured direct-root append syscalls from 117 to 36 and `openWritable` syscalls from 115 to 34 while retaining identity and cleanup checks. ([#966](https://github.com/openclaw/fs-safe/pull/966))
- **Native Root verification:** batch verification and checked close to reduce dispatch overhead while retaining identity checks and close-error handling. ([#955](https://github.com/openclaw/fs-safe/pull/955))
- **macOS file watching:** avoid JavaScript reconciliation for unrelated sibling writes and child-only changes to directory entry scopes while preserving missing-entry discovery and replacement notifications. ([#968](https://github.com/openclaw/fs-safe/pull/968))

### Docs and Tooling

- **Durable queue design:** document a link-free ownership protocol and mixed-version boundaries. ([#969](https://github.com/openclaw/fs-safe/pull/969))
- **Benchmark comparisons:** balance independent build comparisons and restore benchmark setup in relocated checkouts. ([#976](https://github.com/openclaw/fs-safe/pull/976), [#970](https://github.com/openclaw/fs-safe/pull/970))

## 0.26.2 - 2026-10-11

### Highlights

- **Windows receipt round trips:** use exact bigint identities from fs-safe receipts with the fail-closed identity checks introduced in 0.26.1. ([#962](https://github.com/openclaw/fs-safe/pull/962))

### Fixes

- **Windows file identity:** publication, reads, opens, directory and temporary-workspace receipts, typed listings, and clone metadata now expose bigint `exactIdentity`; publication failures expose `exactTargetIdentity`. Pass the exact form back to identity-checking APIs, including publication and copy expectations, to avoid rejecting rounded legacy Number identities on volumes with large file IDs. Existing exact copy and staged-file receipts remain supported. ([#962](https://github.com/openclaw/fs-safe/pull/962))

### Performance

- **Windows permission inspection:** avoid PowerShell startup for portable owner and ACL queries, about 8× faster in a Windows x64 probe, while preserving injected executors and .NET ACL semantics; requires .NET Framework 4.6.2+. ([#958](https://github.com/openclaw/fs-safe/pull/958))

## 0.26.1 - 2026-10-11

### Highlights

- **Windows identity checks:** reject rounded file IDs; callers supplying identity stats must use bigint values. ([#949](https://github.com/openclaw/fs-safe/pull/949))
- **Listings and copies:** measured listings are 38–54% faster on Linux and Windows; direct synchronous file copies are 11–31% faster, with Windows batches up to 48% faster. ([#934](https://github.com/openclaw/fs-safe/pull/934), [#932](https://github.com/openclaw/fs-safe/pull/932))
- **Windows private creation:** the portable helper is about 5× faster, and private creation works beyond MAX_PATH. ([#930](https://github.com/openclaw/fs-safe/pull/930), [#924](https://github.com/openclaw/fs-safe/pull/924))
- **Native overhead:** reduce dispatch and repeated admission for direct-child mkdir, removal, moves, existing-file opens, buffered publication, and async temp creation; measured eligible cases reach or improve on fallback performance while retaining native checks. ([#927](https://github.com/openclaw/fs-safe/pull/927), [#928](https://github.com/openclaw/fs-safe/pull/928), [#929](https://github.com/openclaw/fs-safe/pull/929), [#948](https://github.com/openclaw/fs-safe/pull/948), [#953](https://github.com/openclaw/fs-safe/pull/953))

### Fixes

- **Windows file identity:** stop accepting rounded Number file IDs as matches. Callers supplying identity stats must now pass bigint stats; unsafe Number identities fail with `path-mismatch`. ([#949](https://github.com/openclaw/fs-safe/pull/949))
- **Windows long paths:** support private directory and file creation beyond MAX_PATH, including internal staging and pathname verification, while preserving ACL, alias, identity, and cleanup checks. ([#924](https://github.com/openclaw/fs-safe/pull/924))

### Performance

- **Listings and traversal:** avoid per-entry filename buffers for losslessly decoded names, making measured Linux and Windows listings 38–54% faster; halve per-entry promise allocation in complete sorted `Root.walk()` scans, improving measured 50,000-entry Linux walks by 3–4%. ([#934](https://github.com/openclaw/fs-safe/pull/934), [#937](https://github.com/openclaw/fs-safe/pull/937))
- **File copies and moves:** reuse canonical admission in `copyRootFileSync`, improving measured direct copies by 11–31% on Linux and Windows and batches by up to 47–48% on Windows; reduce ordinary `Root.copyIn()` and same-parent move promise allocation without claiming a reproduced latency gain. ([#932](https://github.com/openclaw/fs-safe/pull/932), [#941](https://github.com/openclaw/fs-safe/pull/941), [#936](https://github.com/openclaw/fs-safe/pull/936))
- **Reads and hashing:** trim file-admission and bounded-read metadata work for 2–9% faster measured Linux reads; reuse privately owned Windows handles for 42% faster native async SHA-256 on small pathname inputs, retaining borrowed-handle positions. ([#931](https://github.com/openclaw/fs-safe/pull/931), [#938](https://github.com/openclaw/fs-safe/pull/938))
- **Locks and directories:** reduce uncontended sidecar-lock acquisition overhead by up to 34% with native; remove ordinary mkdir dispatch hops for 37% faster native direct-child creation, 17–22% faster existing-directory admission, and 81% faster native `ensureRoot` in the combined Linux benchmark. ([#939](https://github.com/openclaw/fs-safe/pull/939), [#944](https://github.com/openclaw/fs-safe/pull/944), [#927](https://github.com/openclaw/fs-safe/pull/927))
- **Temporary workspaces and removal:** make measured empty-workspace cleanup 13–32% faster on Linux, create async workspaces through retained parents, and reduce recursive-removal stat allocation for 2–6% faster measured Linux recursive removal; retain identity-bound cleanup. ([#942](https://github.com/openclaw/fs-safe/pull/942), [#953](https://github.com/openclaw/fs-safe/pull/953), [#933](https://github.com/openclaw/fs-safe/pull/933))
- **Private and exclusive creation:** run portable Windows security checks in a prebuilt helper for about 5× faster private creation; streamline exclusive-creation metadata and skip redundant Windows write-mode changes without removing flushes or permission checks. ([#930](https://github.com/openclaw/fs-safe/pull/930), [#935](https://github.com/openclaw/fs-safe/pull/935), [#940](https://github.com/openclaw/fs-safe/pull/940))
- **Native operations:** reuse retained roots for removal and moves, defer parent creation until an opened file is missing, and streamline buffered creation and replacement-write publication; preserve descriptor-relative mutation and exact identity checks. Native non-durable publication reaches fallback parity in the measured cases; durable creation remains slower. ([#928](https://github.com/openclaw/fs-safe/pull/928), [#929](https://github.com/openclaw/fs-safe/pull/929), [#948](https://github.com/openclaw/fs-safe/pull/948))

### Docs and Tooling

- **Raw Node baseline:** add `pnpm benchmark:node` with alternating raw/safe/control samples and documented operation semantics; raw Node is a performance reference, not a security-equivalent implementation. ([#925](https://github.com/openclaw/fs-safe/pull/925))
- **Native API reference:** enumerate APIs that require native bindings and their fallback availability. ([#926](https://github.com/openclaw/fs-safe/pull/926))

## 0.26.0 - 2026-10-10

### Highlights

- **New platforms:** native packages for FreeBSD x64/arm64 and Windows ARM64. ([#905](https://github.com/openclaw/fs-safe/pull/905), [#893](https://github.com/openclaw/fs-safe/pull/893))
- **Native capabilities:** anonymous pipes, Linux write leases, Darwin ACL inspection, ReFS block cloning, and metadata- and link-preserving `Root.copyIn`. ([#892](https://github.com/openclaw/fs-safe/pull/892), [#896](https://github.com/openclaw/fs-safe/pull/896), [#920](https://github.com/openclaw/fs-safe/pull/920), [#921](https://github.com/openclaw/fs-safe/pull/921))
- **Android/Termux publication:** staged no-replace copies and writes work when the OS refuses hard links. ([#888](https://github.com/openclaw/fs-safe/pull/888))
- **Performance:** faster deep archive extraction, borrowed-handle copies and overwrites, sidecar locks, and Linux descriptor verification, with identity checks retained. ([#912](https://github.com/openclaw/fs-safe/pull/912), [#906](https://github.com/openclaw/fs-safe/pull/906), [#902](https://github.com/openclaw/fs-safe/pull/902), [#901](https://github.com/openclaw/fs-safe/pull/901), [#899](https://github.com/openclaw/fs-safe/pull/899))

### Features

- **ReFS file copies:** support guarded `Root.copyIn` block cloning on Windows ReFS and Dev Drive, with exclusive publication, cancellation cleanup, and automatic byte-copy fallback for unavailable clone capabilities. ([#920](https://github.com/openclaw/fs-safe/pull/920))
- **Guarded file copying:** add `Root.copyIn` metadata preservation and exclusive literal-link copying, including dangling Windows file and directory links; keep permission selection separate from timestamps and attributes. ([#921](https://github.com/openclaw/fs-safe/pull/921))

- **Native filesystem capabilities:** add Linux write leases on caller-owned descriptors, no-follow Darwin ACL inspection with separate file and directory inheritance facts, and Windows sharing-lock, attribute, and physical-extent test fixtures. ([#896](https://github.com/openclaw/fs-safe/pull/896))
- **Anonymous pipes:** add `@openclaw/fs-safe/pipe` with native-owned, reopenable close-on-exec pipe ends for one-shot child input on POSIX, including safe stream closure in Workers. ([#892](https://github.com/openclaw/fs-safe/pull/892))

### Fixes

- **Windows creation diagnostics:** retain native Win32 error numbers through private directory and file creation failures, including the command fallback, without changing semantic error codes. ([#919](https://github.com/openclaw/fs-safe/pull/919))
- **FreeBSD native packages:** add x64 and arm64 packages for FreeBSD 14.4+, with native anonymous pipes and canonicalization, and explicit capability absence for unported operations. ([#905](https://github.com/openclaw/fs-safe/pull/905))
- **Partial native bindings:** select guarded fallbacks when an operation's native capabilities are absent, and report typed capability errors in required mode before mutation. ([#905](https://github.com/openclaw/fs-safe/pull/905))
- **Android/Termux publication:** publish staged no-replace copies and writes when hardlinks are refused, using a verified empty placeholder before atomic replacement; include `EACCES` in the public hardlink-to-copy fallback classifier. Reported in [openclaw/openclaw#167791](https://github.com/openclaw/openclaw/issues/167791). ([#888](https://github.com/openclaw/fs-safe/pull/888))
- **Native ZIP names:** preserve CP437 decoding for unflagged legacy filenames after the ZIP 9 upgrade, including collision rejection and bounded entry selection; continue rejecting invalid Unicode Path checksums and encodings before decoder normalization. ([#885](https://github.com/openclaw/fs-safe/pull/885))
- **Native ZIP Unicode fields:** retain rejection of invalid Unicode Comment CRCs and UTF-8 before callbacks or bounded reads, and validate sequential Unicode fields in decoder order without repeated hashing of the original name. ([#887](https://github.com/openclaw/fs-safe/pull/887))
- **Portable ZIP extraction:** accept safe relative root-directory markers such as `./` from libarchive and other producers without turning them into absolute paths; root markers remain skipped before callbacks and publication. ([#886](https://github.com/openclaw/fs-safe/pull/886))
- **Durable JSON queues on Android/Termux:** claim, failed-entry quarantine, and retirement recovery report typed `helper-unavailable` errors when hardlinks are refused, preserving pending, claimed, and retirement evidence for retry. ([#889](https://github.com/openclaw/fs-safe/pull/889))
- **Windows exclusive publication:** preserve dangling destination symlinks when a refused hard link falls back to placeholder publication. ([#894](https://github.com/openclaw/fs-safe/pull/894))
- **Native mkdir collisions:** `Root.mkdir` consistently reports `not-file` for an existing regular-file destination in native require mode. ([#895](https://github.com/openclaw/fs-safe/pull/895))
- **Guest directory publication:** report a changed source identity instead of a false destination collision when a Linux fallback rename refuses a substituted source. ([#898](https://github.com/openclaw/fs-safe/pull/898))
- **Native recursive removal:** honor a zero entry budget before ignoring a missing target, including with `force`. ([#904](https://github.com/openclaw/fs-safe/pull/904))

### Performance

- **Linux opened-file verification:** read ordinary procfs descriptor paths directly instead of walking realpath, keeping identity checks and deleted-path canonicalization; `readLocalFileSafely` is 25–28% faster on deep paths. ([#899](https://github.com/openclaw/fs-safe/pull/899))
- **Borrowed handles and locks:** keep descriptor metadata inspection off the asynchronous I/O queue for small overwrites (26–28% faster) and copies (31–34% faster), and skip a redundant parent `mkdir` when acquiring sidecar locks (15–18% faster). ([#901](https://github.com/openclaw/fs-safe/pull/901), [#902](https://github.com/openclaw/fs-safe/pull/902), [#906](https://github.com/openclaw/fs-safe/pull/906))
- **Deep archive extraction:** native extraction verifies every retained ancestor through its open descriptor instead of repeated realpath walks: about 16% faster at depth 8 and 5–6% at depth 4, with every ancestor substitution check retained. ([#912](https://github.com/openclaw/fs-safe/pull/912))

### Docs and Tooling

- **Docs accuracy:** correct native-mode migration guidance for removed Python settings and bundled TAR fallbacks, clarify Root streaming ownership, create-only visibility, and Linux no-clobber move fallback limits, and fix the JSON-store and stale-lock examples so denied process probes keep live locks; README and docs examples are now type-checked in CI. ([#897](https://github.com/openclaw/fs-safe/pull/897), [#900](https://github.com/openclaw/fs-safe/pull/900), [#903](https://github.com/openclaw/fs-safe/pull/903))

### Compatibility

- **Windows ARM64:** add a native ARM64 package with real Windows 11 ARM64 and x64-emulation validation, including private ACL creation and Worker descriptor ownership. ([#893](https://github.com/openclaw/fs-safe/pull/893))

- **Native ZIP metadata:** invalid UTF-8-flagged names now reject instead of decoding lossily or falling back to CP437. Public ZIP extraction, preflight, and reads already reject these names during physical admission. ([#885](https://github.com/openclaw/fs-safe/pull/885))

## 0.25.0 - 2026-10-08

### Highlights

- **Faster synchronous plugin captures:** 16% faster than pre-change main on a measured 6,000-file tree; the new `createRootFileCopyBatchSync` API on `advanced` also reuses directory admissions across copies. ([#878](https://github.com/openclaw/fs-safe/pull/878), [#849](https://github.com/openclaw/fs-safe/pull/849))
- **Guest workspace publication:** works on gVisor and other Linux filesystems that reject `RENAME_NOREPLACE`. ([#876](https://github.com/openclaw/fs-safe/pull/876))
- **Root-backed sidecar locks:** native asynchronous release and exit cleanup no longer strand locks after their Root moves. ([#879](https://github.com/openclaw/fs-safe/pull/879))
- **Guest cross-device moves:** preserve the admitted file permissions. ([#869](https://github.com/openclaw/fs-safe/pull/869))

### Features

- **Guarded copy batches:** `createRootFileCopyBatchSync` on `advanced` reuses directory admissions across synchronous copies on canonical POSIX paths while rechecking ancestor and file identities for every copy; single-file copies also reuse admission within the operation. ([#849](https://github.com/openclaw/fs-safe/pull/849))

### Fixes

- **Root-backed file locks:** native asynchronous release and exit cleanup follow the created lock's retained identity after its Root moves, preserving replacement files and reporting ownership mismatches. ([#879](https://github.com/openclaw/fs-safe/pull/879)) Thanks @axiom-ncis.
- **Temp directory diagnostics:** name rejected roots and ancestors, explain ownership, mode, or symlink failures, and provide safe recovery guidance, including for root-run appliances. Thanks @joequant. ([#877](https://github.com/openclaw/fs-safe/pull/877))
- **Guest directory publication:** publish staged workspaces when Linux filesystems reject `RENAME_NOREPLACE`, with checked file link/unlink fallback and directory rename that can only replace a concurrently created empty directory. ([#876](https://github.com/openclaw/fs-safe/pull/876)) Thanks @valkyriweb.
- **Guest cross-device moves:** preserve the admitted source file's permissions instead of leaving the destination with a broader default mode. ([#869](https://github.com/openclaw/fs-safe/pull/869))
- **Move receipts:** publication receipts capture the source identity after synchronous authorization callbacks return, so a source replaced during authorization is reported accurately. ([#868](https://github.com/openclaw/fs-safe/pull/868))
- **Atomic copy fallback:** report a failed restoration as a failure even when the underlying error carries a restored receipt. ([#851](https://github.com/openclaw/fs-safe/pull/851))
- **Archive read limits:** keep the validated entry-read byte limit fixed when callers mutate the options during a read. ([#852](https://github.com/openclaw/fs-safe/pull/852))
- **Watch on macOS:** reconcile notifications for changes to the watched Root itself immediately instead of waiting for the periodic scan. ([#858](https://github.com/openclaw/fs-safe/pull/858))
- **`pathScope` tilde names:** keep literal `~` directory names inside scoped file and existing-path lookups instead of expanding them. ([#856](https://github.com/openclaw/fs-safe/pull/856))

### Performance

- **Guarded file copies:** reuse checked canonical POSIX roots during initial path admission, reducing repeated path-resolution work in synchronous plugin source captures without changing per-file identity or race checks.
- **Root walks:** reuse normalized directory prefixes, cutting a 50k-file walk by 5.6% and its sampled allocation by about 9% while keeping every filesystem and identity check. ([#870](https://github.com/openclaw/fs-safe/pull/870))
- **Atomic writes:** non-durable async POSIX writes skip a redundant mode change when the staged file already has the requested permissions. ([#871](https://github.com/openclaw/fs-safe/pull/871))
- **Guarded mutations:** fewer promise allocations around synchronous guard checks, with directory identity checks unchanged. ([#857](https://github.com/openclaw/fs-safe/pull/857))
- **Archive publication:** fewer promise allocations in archive guard checks, without removing identity or containment checks. ([#864](https://github.com/openclaw/fs-safe/pull/864))
- **Watch:** Linux and Windows watch passes skip macOS stream-path preparation. ([#860](https://github.com/openclaw/fs-safe/pull/860))
- **Permission diagnostics:** bound escaping work for large error messages without changing the displayed excerpts. ([#859](https://github.com/openclaw/fs-safe/pull/859))

## 0.24.2 - 2026-10-07

### Fixes

- **Linux exclusive publication:** `publishFileExclusive` with `rename-noreplace` uses the identity-checked link/unlink move fallback in native `auto` when `RENAME_NOREPLACE` is unsupported, consumes the source on success, and reports `fallback: "link-unlink"` plus precise partial-failure receipts; native `require` stays fail-closed. Link/unlink is not crash-atomic. ([#843](https://github.com/openclaw/fs-safe/pull/843), [openclaw#166246](https://github.com/openclaw/openclaw/issues/166246)) Thanks @MertBasar0.
- **Native clone descriptors:** native file copies return read-write descriptors, so Linux clones can be read immediately and macOS clones can be written while preserving read-only source modes. ([#844](https://github.com/openclaw/fs-safe/pull/844))

## 0.24.1 - 2026-10-06

### Features

- **Pinned source copies:** `copyRootFileSync` accepts `expectedSourceIdentity` to reject a replaced source before destination creation and returns the verified `sourceIdentity` for every copy method. This refines the `copyRootFileSync` API introduced in 0.24.0. ([#841](https://github.com/openclaw/fs-safe/pull/841))

## 0.24.0 - 2026-10-06

### Highlights

- **No-replace moves on more Linux filesystems:** when filesystems reject `renameat2` with `RENAME_NOREPLACE`, including reported QNAP ZFS shares and some overlay mounts, `auto` falls back safely: directories use plain rename that can at most replace an empty directory, and files use identity-checked link/unlink that cannot overwrite a target. Native `require` fails closed. ([#838](https://github.com/openclaw/fs-safe/pull/838), fixes [openclaw#165617](https://github.com/openclaw/openclaw/issues/165617)) Thanks @StarGazer1995, original reporter @bbs2i58, and @MertBasar0.
- **Synchronous guarded copies:** new `copyRootFileSync` on `advanced` supports APFS cloning, reflinks, `copy_file_range`, and guarded byte fallback, returning an owned destination descriptor for synchronous capture hashes. ([#839](https://github.com/openclaw/fs-safe/pull/839))
- **Public capability classification:** new `isNoReplaceUnsupported(error)` identifies unavailable no-replace rename support without matching internal native error codes. ([#838](https://github.com/openclaw/fs-safe/pull/838))

### Features

- **Synchronous root-to-root copy:** `copyRootFileSync` exclusively creates an absent destination under its admitted root, bounds the copy with `maxBytes`, verifies source and destination identities, and returns a disposable descriptor with copy-method and byte-count receipts. ([#839](https://github.com/openclaw/fs-safe/pull/839))
- **No-replace error classifier:** export `isNoReplaceUnsupported(error)` from the root package and `errors` subpath for stable `helper-unavailable` capability diagnostics. ([#838](https://github.com/openclaw/fs-safe/pull/838))

### Fixes

- **Linux no-replace moves:** `Root.move()` uses retained-parent file link/unlink or directory rename when `RENAME_NOREPLACE` is unsupported in `auto`, rejects file collisions, and preserves publication/source-removal details after partial failures. ([#838](https://github.com/openclaw/fs-safe/pull/838)) Thanks @StarGazer1995, @bbs2i58, and @MertBasar0.

### Performance

- **Synchronous copy acceleration:** reuse the native bounded copy engine for APFS clones, Linux reflinks, and `copy_file_range` before byte copying when `copyRootFileSync` is called with `clone: "auto"`. ([#839](https://github.com/openclaw/fs-safe/pull/839))

### Compatibility

- **Move fallback limits:** native `require` keeps refusing unsupported no-replace moves. In `auto`, the directory fallback can replace a concurrently created empty directory; nonempty directories and non-directory competitors reject. File fallback requires hard-link support and fails closed if links are denied or unsupported. ([#838](https://github.com/openclaw/fs-safe/pull/838))
- **Synchronous copy contract:** `copyRootFileSync` defaults to `clone: "never"`, requires existing parents and an absent destination, and performs direct exclusive creation. Use a private capture directory; it does not promise atomic publication, crash durability, or a coherent snapshot of concurrent in-place edits. ([#839](https://github.com/openclaw/fs-safe/pull/839))

## 0.23.1 - 2026-10-04

### Highlights

- **gVisor and 9p file creation:** `create()` and other no-replace publication fall back in `auto` mode on filesystems that reject `renameat2` with `RENAME_NOREPLACE`; `require` mode fails closed. ([#834](https://github.com/openclaw/fs-safe/pull/834), fixes [#828](https://github.com/openclaw/fs-safe/issues/828)) Thanks @vishnukool.
- **Container copy compatibility:** seccomp or LSM policies denying `FICLONE` no longer break `clone: "auto"` copies, for both single files and `copyTree`. ([#829](https://github.com/openclaw/fs-safe/pull/829), [#835](https://github.com/openclaw/fs-safe/pull/835)) Thanks @Mohl, with co-author credit to @foxsky.
- **macOS watching:** a FIFO at a watched name no longer freezes watching across the process. ([#830](https://github.com/openclaw/fs-safe/pull/830)) Thanks @SebTardif.

### Fixes

- **gVisor file creation:** fall back safely when the filesystem rejects native no-replace publication, clean unpublished stages, and report the missing capability in native-required mode. ([#834](https://github.com/openclaw/fs-safe/pull/834)) Thanks @vishnukool.
- **ZIP collision checks:** reject directory and file names that differ only by case, Unicode normalization, or a trailing separator before extraction or bounded reads. ([#832](https://github.com/openclaw/fs-safe/pull/832)) Thanks @SebTardif.
- **macOS entry watch:** prevent a FIFO at a watched name from blocking every watcher in the process. ([#830](https://github.com/openclaw/fs-safe/pull/830)) Thanks @SebTardif.
- **Disk-full diagnostics:** preserve disk-full (`ENOSPC`) diagnostics and cleanup receipts through combined write and disposal failures instead of reporting a misleading file-type error. ([#833](https://github.com/openclaw/fs-safe/pull/833)) Thanks @steipete.
- **Linux clone fallback:** copies with `clone: "auto"` fall back to guarded byte copying when container seccomp or LSM policy denies `FICLONE`; `clone: "always"` reports `unsupported-platform` and removes its stage. ([#829](https://github.com/openclaw/fs-safe/pull/829)) Thanks @Mohl, with co-author credit to @foxsky.
- **Linux tree clone fallback:** `copyTree` with `clone: "auto"` copies bytes when XFS/ZFS file reflinks are unavailable or denied by container policy; `"always"` reports `unsupported-platform` after partial-tree cleanup. ([#835](https://github.com/openclaw/fs-safe/pull/835)) Thanks @steipete.

## 0.23.0 - 2026-10-02

### Highlights

- **BREAKING: Python bridge removed:** remove the Python bridge and its compatibility options; migrate to `configureFsSafeNative` / `FS_SAFE_NATIVE_MODE`. ([#815](https://github.com/openclaw/fs-safe/pull/815))
- **Watch overflow:** fold busy hints so unselected sibling churn beside a missing tree no longer overflows the watch. ([#813](https://github.com/openclaw/fs-safe/pull/813))
- **Windows exclusive creation:** no longer follows unchanged dangling file symlinks, including standalone creators, unrooted locks and cross-volume copy publication. ([#823](https://github.com/openclaw/fs-safe/pull/823), [#824](https://github.com/openclaw/fs-safe/pull/824))
- **Faster metadata listings:** reduce path normalization and per-entry allocation when listing Root directory metadata. ([#818](https://github.com/openclaw/fs-safe/pull/818), [#819](https://github.com/openclaw/fs-safe/pull/819))

### Fixes

- **Windows directory preparation:** retain exact file identities in `ensureAbsoluteDirectory()` so a replaced directory cannot compare equal after large Windows file IDs are rounded to JavaScript numbers. ([#825](https://github.com/openclaw/fs-safe/pull/825))
- **Windows writable creation:** in native `auto`/`off` mode, `openWritable()`, `append()`, and create-only writes could create a dangling file symlink's missing in-Root target before rejecting the link. Check final leaves before fallback creation; outside-Root targets were already rejected. ([#823](https://github.com/openclaw/fs-safe/pull/823))