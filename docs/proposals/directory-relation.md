---
title: "Proposal: directory relationship probing"
description: "A proposed asynchronous comparison of existing and prospective directory roots."
---

# Proposal: directory relationship probing

**Status: draft design; not implemented or exported.** This proposal adds one
asynchronous helper to `@openclaw/fs-safe/advanced` for determining whether two
directory roots coincide, contain one another, or are disjoint. Adoption would
follow an implementation, validation, and a future fs-safe release. This document
does not change runtime behavior, package dependencies, or publication policy.

## Consumer problem

OpenClaw's onboarding migration must keep its workspace, agent, and report
destinations separate before promoting staged directories. Its
[`assertDisjointPromotionTargets` implementation](https://github.com/openclaw/openclaw/blob/2275c485045a711aaf477e90275c0bb15eeac237/src/wizard/setup.migration-promotion.ts#L387)
currently owns roughly 100 lines of filesystem comparison: resolving existing
ancestors, retaining missing suffixes, creating case and Unicode probes, cleaning
them up, and comparing the resulting paths.

That implementation observes case and normalization behavior near a destination,
then folds the entire path. A local observation does not describe every ancestor,
child directory, or mounted filesystem. Moving the relationship operation into
fs-safe would remove this duplicated machinery and compare the relevant names
under their actual directories. OpenClaw would retain the migration decision,
error messages, and authority to promote data.

The consumer already uses asynchronous filesystem operations. The replacement
must perform real asynchronous I/O; a Promise around synchronous traversal or
temporary probing would block the event loop on deep or slow filesystems.

## Proposed API

The following declarations describe a proposed export, not the current package:

```ts
type DirectoryRelation = "same" | "ancestor" | "descendant" | "disjoint";

type ProbeDirectoryRelationOptions = {
  left: string;
  right: string;
  allowTemporaryProbe?: boolean;
  maxDepth?: number;
};

declare function probeDirectoryRelation(
  options: ProbeDirectoryRelationOptions,
): Promise<DirectoryRelation | undefined>;
```

`ancestor` means that **left contains right**; `descendant` means that left is
inside right. Both relationships are strict: equal roots return `same`.

| Result | Meaning |
| --- | --- |
| `same` | Both inputs identify the same directory root, or equivalent prospective directory locations beneath observed existing parents. |
| `ancestor` | The left directory root contains the right location. |
| `descendant` | The right directory root contains the left location. |
| `disjoint` | The observations establish that neither directory location contains the other. |
| `undefined` | The comparison remains uncertain under the selected observation policy. |

`allowTemporaryProbe` defaults to `false`. Omission guarantees that this helper
does not create probe entries. Set it to `true` only when creating temporary
directories under the relevant existing parents is permitted. Temporary probes
remain unnecessary when existing entries or identical ordinary suffixes provide
an answer.

The inputs describe existing or prospective **directories**, including initial
symlink aliases. An existing final file or a non-directory traversal component
rejects with `FsSafeError("not-file")`. This avoids introducing separate
file-hardlink and directory-location meanings for `same`.

There is no synchronous twin, batch comparator, cache, configurable case fold,
or policy callback in this proposal. Those need their own concrete consumers.

## Resolution and comparison

Capture and validate both inputs and options before awaiting work or mutating
the filesystem. Relative inputs use a captured working-directory anchor; option
getters and later working-directory changes must not retarget an admitted path.
Windows drive-relative inputs retain their drive-specific anchor.

Follow existing symlinks with the physical component semantics documented by
[`resolvePathPrefixSync()`](../path-prefix.md). In particular, resolve `link/..`
through the link's target before traversing its parent. At the first missing
entry, retain the unresolved suffix separately from the existing canonical
prefix. A raw suffix such as `missing/../target` returns `undefined`; collapsing
it would invent a relationship to a path that cannot currently be traversed.
Other unsupported raw suffixes, including unresolved dot components, also
remain uncertain rather than being lexically normalized into an answer.

Use strict directory observations with exact bigint identities to align existing
parents and recognize aliases. Unknown or unstable identity is insufficient to
claim equality or disjointness. In particular, do not use permissive
`sameFileIdentity()` comparisons as affirmative proof when Windows reports an
unknown identity component. Recheck the observations used in the comparison and
return `undefined` when detected changes invalidate them.

Compare corresponding prospective components through the shorter suffix. Once
their equivalence is established, the suffix lengths distinguish `same`,
`ancestor`, and `descendant`. A reliably distinct component establishes
`disjoint`. An uncertain component does not.

Observe case and Unicode aliases under the relevant existing directory and,
when explicitly permitted, through owned probe directories modeling inherited
lookup behavior for the missing suffix. Do not lowercase or normalize complete
paths, infer behavior from the operating system, or apply one directory's
observation to another existing directory. Policy exclusions from
`shouldProbeCaseVariants` are not evidence of disjointness and are not part of
this API.

## Errors, uncertainty, and cleanup

Initial path resolution preserves actionable filesystem failures. For example,
an `EACCES` opening an existing ancestor, an `EIO` inspecting it, or an `ELOOP`
resolving a symlink must reject with the original error. If a native failure is
translated into an existing typed fs-safe error, retain the original as its
`cause`. Do not turn an inaccessible input into `undefined` and replace its
useful diagnostic with a generic request to retry. Only `ENOENT` establishes a
prospective suffix; a known non-directory is the typed failure described above.

Reserve `undefined` for observation or probe uncertainty: insufficient read-only
evidence, unsupported unresolved suffixes, unknown identities, detected changes,
exhausted collision or observation budgets, or an optional suffix probe whose
observation or cleanup cannot be verified. An unavailable optional probe follows
the existing [suffix-probe contract](../path-suffix-aliases.md#results-and-caller-policy).
This does not erase errors from the initial resolution of the requested paths.
Malformed option values reject with `TypeError` or `RangeError`, rather than
becoming an uncertain filesystem result.

Temporary creation, observation, and cleanup belong to the existing suffix-probe
owner's lifecycle, extended with actual asynchronous I/O. Reuse its identity
checks, inherited directory behavior, and non-recursive reverse cleanup. Do not
create the requested destination names directly in an unowned parent, chmod an
existing directory, recurse through an unexpected entry, or remove a replacement
to obtain an answer. Incomplete cleanup cannot accompany a successful relation;
`undefined` may mean that an unverified temporary entry was preserved.

## Bounds and API fit

Use the existing [suffix-probe resource bounds](../path-suffix-aliases.md#resource-budgets)
instead of introducing another budget policy. `maxDepth` has the same default of
32 and non-negative safe-integer validation. It bounds the prospective suffixes
admitted for comparison, including identical suffixes; it does not cap existing
prefix traversal. Existing input-size limits, actual-depth scaling, collision
limits, and cleanup outside the forward budget remain applicable. These are
work and size limits, not a wall-clock guarantee.

The operation belongs in `/advanced` because it composes filesystem observations
for a caller-owned decision. Existing APIs cover different responsibilities:

| Existing API | Responsibility retained |
| --- | --- |
| `resolvePathPrefixSync()` | Physical prefix resolution with a raw missing suffix; it does not compare two locations. |
| `probePathSuffixAliasesSync()` | Alias observations for equal-depth ordinary missing suffixes beneath one directory. |
| `probePathCaseInsensitiveSync()` | A local ASCII-case observation, not a whole-path or Unicode equivalence rule. |
| `readDirectoryIdentity()` | An exact directory identity observation. |
| `isPathInside()` | Lexical path comparison, without these filesystem observations. |

Keep these public contracts unchanged. Share their relevant parsing, comparison,
identity, and probe-ownership logic while adding real asynchronous filesystem
operations. Calling the synchronous helpers from an `async` function is not an
implementation of this proposal. A general I/O adapter framework is unnecessary.

The result is not an authorization receipt, path reservation, lock, or consistent
snapshot. Existing entries can change after observation; missing directories may
later be created with different properties. Disjoint roots can still contain
symlinks or hardlinked files referring to shared data. Callers retain mutation
admission, concurrency control, and subsequent guarded filesystem operations.

## Eventual OpenClaw call site

After this API is implemented and released, OpenClaw could replace its generic
comparison helpers with one call inside its existing pair loop:

```ts
const relation = await probeDirectoryRelation({
  left: current.finalPath,
  right: other.finalPath,
  allowTemporaryProbe: true,
});
if (relation === undefined) {
  throw new Error("Could not establish whether migration targets overlap.");
}
if (relation !== "disjoint") {
  throw new Error(`Migration promotion targets overlap: ${current.finalPath} and ${other.finalPath}.`);
}
```

This proposed snippet deliberately lets filesystem errors propagate with their
causes. OpenClaw already performs temporary probes for these destinations; that
caller would explicitly opt in and retain its own overlap and uncertainty
policy. The actual production-line reduction must be measured in the consumer
PR. No OpenClaw adoption should land against an unreleased fs-safe API.

## Evidence needed before implementation lands

Cover existing and missing siblings, both containment directions, exact equality,
symlink and dangling-link aliases, physical `link/..`, unresolved `missing/..`,
and existing non-directories. Filesystem-backed cases must distinguish case and
Unicode behavior locally, including differing directory behavior where supported.
Preserve initial `EACCES` and `EIO` causes. Exercise identity changes, probe
collisions, resource exhaustion, and incomplete cleanup without deleting foreign
entries, and prove that default observation creates nothing.

Measure shallow and deep comparisons and event-loop responsiveness against the
current asynchronous OpenClaw flow, using actual paths and recording the tested
filesystem. Complete the normal fs-safe exports, docs, package, and cross-platform
checks for the implementation. This draft specifies that proof; it does not claim
an implementation, benchmark result, or production-line saving has been verified.
