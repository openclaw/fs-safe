---
title: Path suffix alias probing
description: "Bounded local observations for selected missing relative path suffixes."
---

# Path suffix alias probing

`probePathSuffixAliasesSync()` observes whether selected missing relative suffixes
would alias beneath an existing directory. It returns `boolean | undefined`; it
does not infer filesystem behavior from the operating system or normalize a path
into an authorization decision.

```ts
import { probePathSuffixAliasesSync } from "@openclaw/fs-safe/advanced";

const aliases = probePathSuffixAliasesSync({
  directory: "/trusted/existing-directory",
  left: "Reports/Caf\u00e9",
  right: "reports/Cafe\u0301",
});
if (aliases === undefined) {
  // The caller must choose an explicit ambiguity policy.
}
```

Use this for suffixes that do not yet exist. For local ASCII-case observations,
including an explicit read-only mode, use
[`probePathCaseInsensitiveSync()`](path-case.md). Suffix probing has no read-only
mode: a nontrivial observation can create and remove directories and requires an
approved writable parent.

## API and validation

```ts
type ProbePathSuffixAliasesOptions = {
  directory: string;
  left: string;
  right: string;
  maxDepth?: number;
  shouldProbeCaseVariants?: (leftNfc: string, rightNfc: string) => boolean;
};

function probePathSuffixAliasesSync(
  options: ProbePathSuffixAliasesOptions,
): boolean | undefined;
```

The helper reads `directory`, rejects non-string values and supplied paths longer
than 32,768 code units, then rejects NUL-containing inputs. It resolves the path
to an absolute path and applies the same limit to that result before reading
`maxDepth`. Each option is read once. Later option getters or the predicate cannot retarget a
relative directory by changing the working directory. When
filesystem observations are needed, the directory is canonicalized and its
identity is checked; an initial directory alias can be followed.

Suffixes must have the same number of ordinary relative path components. Empty
components, `.` and `..`, absolute suffixes, NUL characters, and non-string path
inputs are rejected with `TypeError`. Windows additionally rejects drive-relative
components, colons, and reserved device names, including device aliases with
extensions or trailing ignored characters. On POSIX, backslashes and colons are
ordinary filename characters. The optional predicate must be a function.
`maxDepth` defaults to `32` and must be a non-negative safe integer; invalid
values, including `Infinity`, throw `RangeError` before mutation or an
identical-suffix return. A value of `0` admits no ordinary nonempty suffix.

Both suffixes and the predicate are validated before the identical-suffix fast
path. Identical, valid, within-budget suffixes return `true` without filesystem
access or a predicate call. This does not prove that the directory exists or that
the suffix can be created.

The forward-observation allowance never exceeds 32,768, even with a large
`maxDepth`. A deeper or repeatedly colliding probe can return `undefined` when
that ceiling is reached. Reverse cleanup still runs outside this allowance.

## Resource budgets

The default limits for one call are:

| Resource | Limit | On exceeding the limit |
|---|---|---|
| Each supplied suffix | 8,192 UTF-16 code units | `RangeError` before mutation |
| Supplied and resolved directory paths | 32,768 UTF-16 code units each | `RangeError` before mutation |
| Each suffix's component count | `maxDepth`, default 32 | `RangeError` before mutation |
| Directory-creation attempts | 128 | `undefined` after cleanup |
| Successfully created probe directories | 64 | `undefined` after cleanup |
| Forward filesystem observations | 4,096 | `undefined` after cleanup |
| Each generated actual path | 32,768 UTF-16 code units | `undefined` after cleanup |

### Deeper observations

Applications comparing deeper prospective paths can explicitly raise `maxDepth`:

```ts
const prefix = "future/".repeat(32);
const aliases = probePathSuffixAliasesSync({
  directory: "/trusted/existing-directory",
  left: `${prefix}Report.sqlite`,
  right: `${prefix}report.sqlite`,
  maxDepth: 33,
});
```

The 8,192-code-unit suffix limit and 32,768-code-unit path limits remain fixed.
Ordinary-component validation, Windows path controls, identity checks, and
cleanup rules also remain unchanged.

Operation budgets grow proportionally from the actual admitted suffix depth,
not the requested `maxDepth`. For actual depth `D`, let `B = max(32, D)`.
Directory-creation attempts are limited to `4 × B`, successfully created
directories to `2 × B`, and forward filesystem observations to `min(32,768, 4 × B²)`.
The quadratic observation allowance accommodates rechecks of owned ancestors.

For example, 33 components allow 132 creation attempts, 66 created directories,
and 4,356 forward observations; 65 components allow 260, 130, and 16,900.
Specifying a large `maxDepth` for a short suffix keeps the original budgets.
The suffix-length limit bounds actual depth to at most 4,096, so every budget
remains a finite safe integer.

Admission does not guarantee a boolean result. Repeated collisions, many
normalization probes, filesystem limits, or identity failures can exhaust the
budget or prevent an observation. The helper then returns `undefined` after
cleanup attempts; callers must preserve their explicit ambiguity policy.

Input limits are checked even for identical suffixes. Dynamic budgets count work
across the whole call, including collision retries; removing a probe does not
restore its creation budget. Cleanup is still attempted when a forward budget is
exhausted and is not disabled by that exhausted budget.

Candidates are generated lazily, only as needed. The helper does not eagerly
allocate every possible probe name or consume randomness for unused retries.
These are count and string-size limits, not a wall-clock guarantee. Synchronous
filesystem calls, randomness, and caller code can block; the helper cannot
interrupt them or promise a maximum elapsed time.

## Results and caller policy

- `true`: the suffixes are identical, or the requested observations found aliases.
- `false`: an observation found distinct entries, or the caller's predicate
  excluded a pair.
- `undefined`: no reliable answer was obtained, including filesystem failures,
  identity changes, exhausted collision candidates or dynamic budgets, generated
  path limits, or incomplete cleanup.

`undefined` is not evidence of either case sensitivity or aliasing. The helper
does not cache observations, choose a fallback, reserve the future destination,
or establish a root-confinement boundary. A result applies only to the local
observations made during that call, not to every Unicode pair, mount, or later
filesystem state.

The optional trusted, synchronous `shouldProbeCaseVariants` predicate receives
NFC-normalized component pairs when they differ and are not equivalent under
ASCII case folding. Without a predicate, those pairs are eligible for probing.
It is called in component order. Returning `false` excludes
that pair and produces `false`; it is caller policy, not a filesystem finding.
A first-component exclusion needs no probes or randomness. A later exclusion
can follow earlier mutations, so it does not make the call read-only.

A non-boolean predicate result throws `TypeError`; a predicate exception is
re-thrown unchanged after cleanup attempts. Cleanup problems do not replace the
original predicate failure. Do not use an asynchronous predicate or rely on the
resource limits to bound arbitrary callback work.

## Probe design

The helper works through corresponding components, creating nested directories
to observe inherited lookup behavior. ASCII-case probes use generated names.
Normalization probes retain the original non-ASCII spellings while substituting
suitable ASCII letters. When a generated pair is unavailable, the exact raw pair
can be tried inside an owned neutral directory. Requested names are never
materialized directly in the caller's unowned parent.

Generated names are conservatively excluded when their NFC lowercase or uppercase
forms could collide with either requested component. These folds are only a name
exclusion rule; they never classify two requested paths as aliases. Short neutral
and ASCII probe names use at most six characters and are no longer than the
shorter requested component. Generated normalization pairs are also limited by
the longer original joined path length. A raw-pair fallback adds a directory
level; filesystem-specific name or path limits can still make it unavailable.

Probes use normal directory creation and the process umask, preserving inherited
directory behavior. They do not force mode `0700`, change parent permissions, or
promise private probe names. Creation and removal can affect directory timestamps
and filesystem watchers.

## Identity and cleanup limitations

The requested directory, canonical parent, and owned probe chain are rechecked
with exact bigint filesystem identities. An alternate spelling must identify the
same ordinary directory, not a symlink or unrelated collision. Existing files,
directories, and symlinks at a candidate name are not removed to make room.

Cleanup attempts owned directories in reverse order with identity checks and
non-recursive removal. Nonempty directories and observed replacements are
preserved. A cleanup failure changes an otherwise boolean result to `undefined`.
If the first identity observation after a successful creation fails, a directory
can remain: the helper does not guess ownership to delete it.

This is a pathname-based observation helper, not an atomic filesystem
transaction. There are unavoidable gaps between creation and the first identity
observation, and between an identity check and a subsequent syscall. No pinned
directory handle or atomic conditional deletion closes those gaps. Use a trusted,
approved writable directory and application-level concurrency control where
needed; do not use this helper as authorization to access attacker-controlled
paths.
