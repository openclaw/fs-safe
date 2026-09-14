# Path suffix alias probing

`probePathSuffixAliasesSync()` compares two missing relative path suffixes at
an existing directory. It observes name lookup on that filesystem and returns
whether they alias, or `undefined` when it cannot establish an answer. The probe
handles the complete suffix, including case and Unicode normalization behavior
inherited by newly created directories.

```ts
import { probePathSuffixAliasesSync } from "@openclaw/fs-safe/advanced";

const aliases = probePathSuffixAliasesSync({
  directory: "/srv/data",
  left: "Reports/Caf\u00e9",
  right: "reports/Cafe\u0301",
});

if (aliases === undefined) {
  // The application decides how to handle an unavailable observation.
}
```

Use this helper when comparing paths whose suffixes do not yet exist. Use
[`probePathCaseInsensitiveSync()`](path-case.md) for a local ASCII-case
observation with an optional read-only mode. Suffix probing can create temporary
directories; it has no read-only option and requires permission to create and
remove entries under `directory`.

## Signature and results

```ts
type ProbePathSuffixAliasesOptions = {
  directory: string;
  left: string;
  right: string;
  shouldProbeCaseVariants?: (leftNfc: string, rightNfc: string) => boolean;
};

function probePathSuffixAliasesSync(
  options: ProbePathSuffixAliasesOptions,
): boolean | undefined;
```

`directory` names the existing observation parent. It is resolved with Node's
`path.resolve()`, and aliases are followed to its canonical directory. `left` and `right` are
relative suffixes with the same number of components. Absolute suffixes, empty
suffixes, empty components, `.` or `..` components, NUL characters, and different
component counts throw `TypeError` before any filesystem mutation. Windows
drive-relative, colon-bearing, or reserved device components such as `CON` and
`COM¹` are also rejected on Windows. POSIX colon and backslash literals remain
valid ordinary component bytes.

Identical valid suffix strings return `true` after argument validation without
accessing the filesystem or invoking the predicate. This shortcut does not
verify that `directory` exists or can be used for later work.

| Result | Meaning |
|---|---|
| `true` | The suffix strings are identical, or the complete suffixes alias under the observed directory behavior. |
| `false` | A component pair is distinct, or the caller's predicate excludes it. |
| `undefined` | Filesystem failure, exhausted temporary-name collisions, uncertain identity, or unsuccessful cleanup prevents a reliable observation. |

The result is local to this directory and these suffixes. The helper does not
guess from the operating system, depend on a native binding, or cache results.
The caller owns fallback, admission, cache invalidation, and later mutation
policy. An observation does not reserve either path or authorize a later write.

## What the probe creates

Components are examined in sequence so child probes retain the directory
behavior inherited along the suffix. ASCII-case pairs use generated case
variants. Generated normalization probes retain the candidates' raw non-ASCII
code points and spellings while replacing eligible ASCII letters; the helper
does not uniformly generate NFC/NFD counterparts. Other Unicode pairs, and
normalization pairs without a usable generated variant, are tested with their
original raw spellings inside exclusively owned neutral directories. Requested
target spellings are never created directly under an unowned parent.

Generated case, neutral, and normalization names exclude NFC-normalized
uppercase or lowercase equivalents of either requested component, including
ASCII case variants. This conservative exclusion avoids using a requested name
as a probe; it does not classify filesystem aliases from JavaScript folding.

Short generated names are at most six ASCII characters and no longer than the
shorter corresponding suffix component. Generated normalization pairs are
filtered against the length of the longer original joined path. That filter is
not a global path-length limit: a neutral directory followed by a raw Unicode
name can add depth and length. For example, a one-component `É`/`é` comparison
can use `directory/d/É`, where `d` stands for a generated neutral name. If that
overhead causes `ENAMETOOLONG`, the result is `undefined` after cleanup is
attempted.

Directories are created exclusively with the existing `mkdir` default mode
and process umask. The helper does not force private `0o700` permissions or
chmod the observation parent. Probing can change directory timestamps and
trigger filesystem watchers even when cleanup succeeds.

## Caller case policy

`shouldProbeCaseVariants` is an optional trusted synchronous predicate. It is
called as needed in suffix order for component pairs whose NFC forms differ
and are not ASCII-case-equivalent. Its arguments are the two NFC-normalized
components. Returning `false` excludes that pair under application policy and
produces a non-alias result.

If the predicate excludes the first component pair, `false` can be returned
without directory metadata access or temporary probes. This policy-only result
does not verify that `directory` exists. Predicates for later components run
only after preceding component observations, so returning `false` is not a
request for read-only probing.

Omitting the predicate lets the helper observe the exact pair directly. The
helper does not impose a locale or special dotted-I policy. Returning a value
other than a boolean throws `TypeError`; an exception from the predicate
propagates unchanged. Both paths attempt cleanup of any already-owned
directories before propagating the error.

## Ownership, cleanup, and uncertainty

The helper retains exact bigint identities for the parent and every owned
directory. It rechecks them before mutations and after observations. Cleanup
removes owned directories nonrecursively, in reverse creation order, and
preserves substitutions and directories that are no longer empty.

A different entry at a generated alternate spelling is a collision, including
a regular file or symlink. The helper preserves that entry and retries another
pair. Unknown identity or failed metadata observation remains `undefined`.

Cleanup failure or preservation invalidates the observation and returns
`undefined`, even if the name comparison had already found an answer.
Integrations migrating from probes that ignore cleanup failures must handle
this conservative result. A trusted predicate error still propagates after
cleanup is attempted.

If a directory is created but its initial identity cannot be obtained, it can
remain on disk: the helper does not guess ownership to remove it. Therefore
`undefined` does not promise that no temporary artifact remains.

Directory creation and its first identity observation are separate operations,
as are the final identity check and each filesystem mutation. These initial
observation and final-syscall gaps remain subject to concurrent namespace
changes. The probe does not retain directory handles or provide atomic
conditional deletion, and a returned result can immediately become stale.
Use it in an approved writable directory with the concurrency controls required
by the application.
